import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  ExecutionContext,
  ExecutionTrace,
  ExecutionPausedEvent,
  GateDecision
} from '@joseki/shared';
import { calculateCost, DEFAULT_GATE_TIMEOUT_SECONDS, DEFAULT_MAX_REVISIONS } from '@joseki/shared';
import Handlebars from 'handlebars';
import { Parser as ExprParser } from 'expr-eval';
import { LLMAdapter, type Generator } from '../adapters/llm';
import { Database } from '../db/database';
import { GateRegistry, gates as sharedGates } from './gates';

// Create a single parser instance for safe branch condition evaluation
const safeExprParser = new ExprParser();

// Prompts are model input, not HTML: a quote in an upstream summary must reach
// the next model as a quote, not as &quot;.
const TEMPLATE_OPTIONS = { noEscape: true };

export interface ExecutionOptions {
  startNodeId?: string;
  context?: ExecutionContext;
  /** Values for input nodes, by node id. Falls back to each node's defaultValue. */
  inputs?: Record<string, unknown>;
  parentExecutionId?: string;
  /** Where human gates wait for their decision. Defaults to the shared registry. */
  gates?: GateRegistry;
  onNodeStart?: (nodeId: string) => void;
  onNodeComplete?: (nodeId: string, trace: ExecutionTrace) => void;
  onStreamToken?: (nodeId: string, token: string) => void;
  /** The run stopped at a human gate and is waiting. */
  onPaused?: (event: ExecutionPausedEvent) => void;
}

/** One upstream output feeding a node, in the order of the arrows into it. */
export interface NodeInput {
  nodeId: string;
  output: unknown;
}

/**
 * What an arrow knows about itself during a run. An arrow is `taken` when
 * its source ran and chose it, `dead` when the source ran and chose a
 * different handle — or never ran at all because it was skipped upstream.
 */
type EdgeState = 'pending' | 'taken' | 'dead';

/** Marker for "the node was skipped, so none of its arrows fire". */
const NO_HANDLE = Symbol('no-handle');

/**
 * A node failed and the run stopped there. `context` holds every node that
 * ran up to and including the failed one, so a caller can still report it.
 */
export class NodeFailedError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly context: ExecutionContext,
    message: string
  ) {
    super(message);
    this.name = 'NodeFailedError';
  }
}

interface RunState {
  executionId: string;
  /** For a human gate: how many times it has already sent work back. */
  revision: number;
}

interface NodeResult {
  trace: ExecutionTrace;
  /**
   * The output handle the node chose. `undefined` means the node has one
   * output and every arrow out of it fires.
   */
  selectedHandle?: string;
  /** For a human gate: what the reviewer decided. */
  decision?: GateDecision;
}

export class WorkflowExecutor {
  private llmAdapter: Generator;
  private db: Database;

  constructor(db: Database, llmAdapter?: Generator) {
    this.llmAdapter = llmAdapter ?? new LLMAdapter();
    this.db = db;
  }

  /**
   * Runs the workflow by following arrows.
   *
   * A node is ready once every arrow into it is resolved. If at least one
   * arrow was taken it runs, fed by the outputs on the taken arrows; if
   * none were, it is skipped and its own arrows die, so a join after a
   * branch waits for exactly the paths that were chosen and no longer.
   * Nodes with several outputs (branch, human gate) choose one handle and
   * only the arrows on that handle fire.
   *
   * An arrow that points backwards — a gate's fail arrow sending work back
   * — is a trigger, not a dependency: its target never waits on it and is
   * not fed by it. When it fires, the target and everything downstream of
   * it are re-run, up to the gate's maxRevisions.
   */
  async execute(
    workflow: Workflow,
    executionId: string,
    options: ExecutionOptions = {}
  ): Promise<ExecutionContext> {
    const context: ExecutionContext = options.context || {};
    const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));

    const incoming = new Map<string, WorkflowEdge[]>();
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const edge of workflow.edges) {
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      incoming.get(edge.target)!.push(edge);
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source)!.push(edge);
    }
    const downstreamOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const id = stack.pop()!;
        for (const edge of outgoing.get(id) ?? []) {
          if (!seen.has(edge.target)) {
            seen.add(edge.target);
            stack.push(edge.target);
          }
        }
      }
      return seen;
    };
    // On a cycle every arrow's target reaches its source, so "points
    // backwards" alone does not single out the arrow that closes the loop.
    // The validator's rule does: only a gate's fail arrow may.
    const backEdges = new Set(
      workflow.edges
        .filter(e => nodeMap.get(e.source)?.type === 'human_gate' && e.sourceHandle === 'fail')
        .filter(e => downstreamOf(e.target).has(e.source))
        .map(e => e.id)
    );
    const forwardIn = (nodeId: string) => (incoming.get(nodeId) ?? []).filter(e => !backEdges.has(e.id));

    const edgeState = new Map<string, EdgeState>();

    const startNodes = options.startNodeId
      ? [options.startNodeId]
      : workflow.nodes.filter(n => forwardIn(n.id).length === 0).map(n => n.id);

    // A run that starts mid-graph gets its upstream from the supplied
    // context; arrows out of those nodes count as taken.
    if (options.startNodeId) {
      for (const edge of workflow.edges) {
        if (edge.source in context) edgeState.set(edge.id, 'taken');
      }
    }

    const done = new Set<string>();
    const touched = new Set<string>(startNodes);
    const queue = [...startNodes];
    const revisions = new Map<string, number>();

    const enqueue = (nodeId: string) => {
      if (!done.has(nodeId) && !queue.includes(nodeId)) {
        queue.push(nodeId);
        touched.add(nodeId);
      }
    };

    /** Marks the node's arrows; returns the ones that fired. */
    const resolveOutgoing = (node: WorkflowNode, selected: string | undefined | typeof NO_HANDLE) => {
      const fired: WorkflowEdge[] = [];
      for (const edge of outgoing.get(node.id) ?? []) {
        const taken = edgeTaken(node, edge, selected);
        edgeState.set(edge.id, taken ? 'taken' : 'dead');
        if (taken) fired.push(edge);
        if (!backEdges.has(edge.id)) enqueue(edge.target);
      }
      return fired;
    };

    /**
     * Forget that `target` and everything after it ran, so they run again.
     * Their outputs stay in the context until overwritten, so the next lap
     * can read the gate's decision.
     */
    const rework = (target: string) => {
      const again = downstreamOf(target);
      again.add(target);
      for (const id of again) {
        done.delete(id);
        for (const edge of outgoing.get(id) ?? []) edgeState.delete(edge.id);
      }
      enqueue(target);
    };

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (done.has(nodeId)) continue;

      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const inEdges = forwardIn(nodeId);
      // Not ready yet; the arrow that resolves last will queue it again.
      if (inEdges.some(e => (edgeState.get(e.id) ?? 'pending') === 'pending')) continue;

      const takenEdges = inEdges.filter(e => edgeState.get(e.id) === 'taken');
      done.add(nodeId);

      if (inEdges.length > 0 && takenEdges.length === 0) {
        const trace = this.skippedTrace(executionId);
        this.db.createExecutionTrace({ ...trace, executionId, nodeId });
        options.onNodeComplete?.(nodeId, trace);
        resolveOutgoing(node, NO_HANDLE);
        continue;
      }

      options.onNodeStart?.(nodeId);

      const inputs: NodeInput[] = takenEdges.map(e => ({
        nodeId: e.source,
        output: context[e.source]?.output
      }));
      const run: RunState = { executionId, revision: revisions.get(nodeId) ?? 0 };
      const { trace, selectedHandle, decision } = await this.executeNode(node, inputs, context, run, options);

      context[nodeId] = decision ? { output: trace.output, trace, decision } : { output: trace.output, trace };
      this.db.createExecutionTrace({ ...trace, executionId, nodeId });
      options.onNodeComplete?.(nodeId, trace);

      // There is no error handling yet, so an arrow out of a failed node has
      // nothing meaningful to carry. Stop here rather than run the rest of
      // the graph on a null.
      if (trace.status === 'error') {
        throw new NodeFailedError(nodeId, context, `Node "${node.data.label}" (${nodeId}) failed: ${trace.error}`);
      }

      const fired = resolveOutgoing(node, selectedHandle);

      if (decision?.verdict === 'fail') {
        if (fired.length === 0) {
          throw new Error(`Rejected at "${node.data.label}" (${nodeId}): the gate has no fail arrow to follow`);
        }
        const sentBack = fired.filter(e => backEdges.has(e.id));
        if (sentBack.length) {
          const limit: number = (node.data.config as any).maxRevisions ?? DEFAULT_MAX_REVISIONS;
          const count = run.revision + 1;
          if (count > limit) {
            throw new Error(
              `"${node.data.label}" (${nodeId}) sent the work back ${count} times; maxRevisions is ${limit}`
            );
          }
          revisions.set(nodeId, count);
          for (const edge of sentBack) rework(edge.target);
        }
      }
    }

    // Anything an arrow reached but that never became ready is waiting on an
    // arrow that will never resolve.
    const stalled = [...touched].filter(id => !done.has(id));
    if (stalled.length) {
      throw new Error(
        `Execution stalled: ${stalled.join(', ')} are waiting on dependencies that will never run ` +
        `(dependency cycle, or the start node's upstream is outside this run)`
      );
    }

    return context;
  }

  private skippedTrace(runId: string): ExecutionTrace {
    return {
      runId,
      timestamp: Date.now(),
      input: null,
      output: null,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      cost: 0,
      latencyMs: 0,
      status: 'skipped'
    };
  }

  private async executeNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext,
    run: RunState,
    options: ExecutionOptions
  ): Promise<NodeResult> {
    const startTime = Date.now();
    const input = this.buildNodeInput(node, inputs, context);

    try {
      let output: any;
      let tokenUsage = { prompt: 0, completion: 0, total: 0 };
      let model: string | undefined;
      let reportedCost: number | undefined;
      let selectedHandle: string | undefined;
      let decision: GateDecision | undefined;

      switch (node.type) {
        case 'prompt': {
          const promptResult = await this.executePromptNode(
            node,
            inputs,
            context,
            options.onStreamToken
          );
          output = promptResult.output;
          tokenUsage = promptResult.tokenUsage;
          model = promptResult.model;
          reportedCost = promptResult.cost;
          break;
        }

        case 'branch':
          output = await this.executeBranchNode(node, inputs, context);
          selectedHandle = output;
          break;

        case 'aggregate':
          output = await this.executeAggregateNode(node, inputs);
          break;

        case 'human_gate': {
          const gate = await this.executeHumanGateNode(node, inputs, run, options);
          output = gate.output;
          decision = gate.decision;
          selectedHandle = decision.verdict;
          // The decision is the reviewer's input to the gate; it belongs
          // with the persisted trace.
          input.decision = decision;
          break;
        }

        case 'model_compare':
          output = await this.executeModelCompareNode(node, inputs, context);
          break;

        case 'input':
          output = this.executeInputNode(node, context, options);
          break;

        case 'output':
          output = inputs.length === 1 ? inputs[0].output : inputs.map(i => i.output);
          break;

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      const latencyMs = Date.now() - startTime;

      // The gateway's own figure when it reports one; otherwise the local
      // price table, for the few models it knows.
      let cost = reportedCost ?? 0;
      if (reportedCost === undefined && model && tokenUsage.total > 0) {
        // getModelConfig returns the pricing pair itself
        const pricing = this.getModelConfig(model);
        if (pricing) {
          cost = calculateCost(tokenUsage, pricing);
        }
      }

      return {
        trace: {
          runId: run.executionId,
          timestamp: startTime,
          input,
          output,
          tokenUsage,
          cost,
          latencyMs,
          status: 'success',
          model
        },
        selectedHandle,
        decision
      };

    } catch (error) {
      return {
        trace: {
          runId: run.executionId,
          timestamp: startTime,
          input,
          output: null,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          cost: 0,
          latencyMs: Date.now() - startTime,
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private executeInputNode(
    node: WorkflowNode,
    context: ExecutionContext,
    options: ExecutionOptions
  ): unknown {
    const config = node.data.config as any;
    const value =
      options.inputs?.[node.id] ??
      context[node.id]?.output ??
      config.defaultValue ??
      '';
    if (config.required && (value === '' || value === null || value === undefined)) {
      throw new Error(`Input "${node.data.label}" is required but no value was supplied`);
    }
    return value;
  }

  private async executePromptNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext,
    onStreamToken?: (nodeId: string, token: string) => void
  ): Promise<{ output: string; tokenUsage: any; model: string; cost?: number }> {
    const config = node.data.config as any;

    // Compile templates with context
    const systemTemplate = Handlebars.compile(config.systemPrompt, TEMPLATE_OPTIONS);
    const userTemplate = Handlebars.compile(config.userPrompt, TEMPLATE_OPTIONS);

    const data = this.templateData(inputs, context);
    const systemPrompt = systemTemplate(data);
    const userPrompt = userTemplate(data);

    const result = await this.llmAdapter.generate({
      model: config.model,
      systemPrompt,
      userPrompt,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      onToken: onStreamToken ? (token) => onStreamToken(node.id, token) : undefined
    });

    return {
      output: result.content,
      tokenUsage: result.tokenUsage,
      model: config.model,
      cost: result.cost
    };
  }

  /**
   * What a template can see: `input` (the first arrow's output, as text),
   * `inputs` (every arrow's output by source node id) and `nodes` (the whole
   * run so far, for {{nodes.<id>.output}} and {{nodes.<gate>.decision.note}}).
   */
  private templateData(inputs: NodeInput[], context: ExecutionContext) {
    const byNode: Record<string, unknown> = {};
    for (const i of inputs) byNode[i.nodeId] = i.output;
    return {
      input: inputs.length ? asText(inputs[0].output) : '',
      inputs: byNode,
      nodes: context
    };
  }

  private async executeBranchNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext
  ): Promise<string> {
    const config = node.data.config as any;
    const conditionStr: string = config.condition || 'true';

    // Build a flat evaluation scope from the execution context.
    // This gives expressions access to node outputs without arbitrary code execution.
    const scope: Record<string, any> = {};

    for (const [nodeId, nodeCtx] of Object.entries(context)) {
      const output = nodeCtx.output;
      scope[nodeId] = asText(output);
      scope[`${nodeId}_output`] = output;
    }

    // "input" is what arrived on the first arrow into this node.
    if (inputs.length) {
      scope['input'] = asText(inputs[0].output);
    }

    try {
      const expr = safeExprParser.parse(conditionStr);
      const result = expr.evaluate(scope);
      return String(result);
    } catch (exprErr) {
      throw new Error(
        `Branch condition "${conditionStr}" could not be evaluated safely: ` +
        `${exprErr instanceof Error ? exprErr.message : String(exprErr)}. ` +
        `Use simple expressions like: input == "yes", score > 0.5, nodeId_output == "approved"`
      );
    }
  }

  private async executeAggregateNode(
    node: WorkflowNode,
    inputs: NodeInput[]
  ): Promise<any> {
    const config = node.data.config as any;
    const outputs = inputs.map(i => i.output);

    switch (config.strategy) {
      case 'concat':
        return outputs.map(asText).join(config.separator || '\n');
      case 'vote':
        // Simple plurality voting
        const counts = new Map<string, number>();
        for (const output of outputs) {
          const key = String(output);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        let maxCount = 0;
        let winner = '';
        for (const [key, count] of counts) {
          if (count > maxCount) {
            maxCount = count;
            winner = key;
          }
        }
        return winner;
      case 'merge':
        return outputs;
      default:
        return outputs;
    }
  }

  /**
   * Stops the run until a person decides. The content under review is what
   * arrived on the arrows in; on pass it goes on unchanged, or replaced by
   * the reviewer's edit when the gate allows edits. On fail the content
   * still goes on, down the fail arrows. A timeout or a cancel rejects the
   * wait, which fails the node and so the run.
   */
  private async executeHumanGateNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    run: RunState,
    options: ExecutionOptions
  ): Promise<{ output: unknown; decision: GateDecision }> {
    const config = node.data.config as any;
    const content = inputs.length === 1 ? inputs[0].output : inputs.map(i => i.output);
    const maxRevisions: number = config.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    const timeoutSeconds: number = config.timeout ?? DEFAULT_GATE_TIMEOUT_SECONDS;

    options.onPaused?.({
      executionId: run.executionId,
      nodeId: node.id,
      content,
      instructions: config.instructions ?? '',
      allowEdit: Boolean(config.allowEdit),
      revision: run.revision,
      maxRevisions
    });

    const registry = options.gates ?? sharedGates;
    const decision = await registry.wait(run.executionId, node.id, timeoutSeconds * 1000);
    if (decision.verdict !== 'pass' && decision.verdict !== 'fail') {
      throw new Error(`Gate decision must be "pass" or "fail", got ${JSON.stringify(decision.verdict)}`);
    }

    const output =
      decision.verdict === 'pass' && config.allowEdit && decision.edited !== undefined
        ? decision.edited
        : content;
    return { output, decision };
  }

  private async executeModelCompareNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext
  ): Promise<any> {
    const config = node.data.config as any;
    const promptTemplate = Handlebars.compile(config.prompt, TEMPLATE_OPTIONS);
    const prompt = promptTemplate(this.templateData(inputs, context));

    const results = await Promise.all(
      config.models.map(async (model: string) => {
        const result = await this.llmAdapter.generate({
          model,
          systemPrompt: '',
          userPrompt: prompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens
        });
        return { ...result, model };
      })
    );

    return { comparisons: results };
  }

  private buildNodeInput(node: WorkflowNode, inputs: NodeInput[], context: ExecutionContext): any {
    // Snapshot of upstream outputs only. The live context holds every node's
    // trace, and each trace holds its input — keeping the reference would make
    // the trace circular and unserializable when it is persisted.
    const byNode: Record<string, unknown> = {};
    for (const i of inputs) byNode[i.nodeId] = i.output;
    const nodes: Record<string, any> = {};
    for (const [id, entry] of Object.entries(context)) {
      if (id !== node.id) nodes[id] = entry.output;
    }
    return { inputs: byNode, nodes };
  }

  private getModelConfig(modelId: string): any {
    // In real implementation, fetch from database
    const configs: Record<string, any> = {
      'gpt-4': { input: 0.03, output: 0.06 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 }
    };
    return configs[modelId];
  }
}

/**
 * Whether an arrow out of `node` fires, given the handle the node chose.
 * An arrow with no handle of its own counts as the node's default handle
 * — a human gate drawn with a single output passes — or, for a node with
 * no default, always fires.
 */
function edgeTaken(
  node: WorkflowNode,
  edge: WorkflowEdge,
  selected: string | undefined | typeof NO_HANDLE
): boolean {
  if (selected === NO_HANDLE) return false;
  if (selected === undefined) return true;
  const handle = edge.sourceHandle ?? defaultHandle(node);
  return handle === undefined || handle === selected;
}

function defaultHandle(node: WorkflowNode): string | undefined {
  return node.type === 'human_gate' ? 'pass' : undefined;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
