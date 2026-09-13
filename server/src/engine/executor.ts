import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  ErrorHandlerConfig,
  ExecutionContext,
  ExecutionTrace,
  ExecutionPausedEvent,
  GateDecision,
  TraceDetail
} from '@joseki/shared';
import {
  asText,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_REVISIONS,
  evaluateCondition,
  MAX_ATTEMPTS,
  promptParams
} from '@joseki/shared';
import Handlebars from 'handlebars';
import { LLMAdapter, type Generator } from '../adapters/llm';
import { Database } from '../db/database';
import { GateRegistry, gates as sharedGates } from './gates';

// Prompts are model input, not HTML: a quote in an upstream summary must reach
// the next model as a quote, not as &quot;.
const TEMPLATE_OPTIONS = { noEscape: true };

/** How long a retrying node waits before its next try, and the ceiling on it. */
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 60_000;

/**
 * The pause after `attempt` failed: half a second, then a second, then two,
 * doubling up to the ceiling. A model that just rate-limited is given room
 * rather than hammered.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface ErrorPolicy {
  strategy: 'retry' | 'default' | 'fail';
  maxAttempts: number;
  fallbackValue: unknown;
}

/**
 * What a node was told to do about failure. Read off the config whatever the
 * node's type, so a node type that grows an error strategy gets one for free;
 * a node that says nothing fails, which is how every node used to behave.
 */
function errorPolicy(node: WorkflowNode): ErrorPolicy {
  const configured = (node.data.config as { onError?: ErrorHandlerConfig }).onError;
  const strategy = configured?.strategy;
  const asked = Number(configured?.maxAttempts);

  return {
    strategy: strategy === 'retry' || strategy === 'default' ? strategy : 'fail',
    maxAttempts: Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), MAX_ATTEMPTS)
      : DEFAULT_MAX_ATTEMPTS,
    fallbackValue: configured?.fallbackValue ?? null
  };
}

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
  private sleep: Sleep;

  constructor(db: Database, llmAdapter?: Generator, sleep: Sleep = realSleep) {
    this.llmAdapter = llmAdapter ?? new LLMAdapter();
    this.db = db;
    this.sleep = sleep;
  }

  /**
   * Runs the workflow by following arrows.
   *
   * A node is ready once every arrow into it is resolved, and it runs the
   * moment it is: nodes that do not depend on each other run at the same
   * time, and a join waits for exactly its own arrows, however they finish.
   * If at least one arrow in was taken the node runs, fed by the outputs on
   * the taken arrows in arrow order; if none were, it is skipped and its own
   * arrows die, so a join after a branch waits for exactly the paths that
   * were chosen and no longer. Nodes with several outputs (branch, human
   * gate) choose one handle and only the arrows on that handle fire.
   *
   * An arrow that points backwards — a gate's fail arrow sending work back
   * — is a trigger, not a dependency: its target never waits on it and is
   * not fed by it. When it fires, the target and everything downstream of
   * it are re-run, up to the gate's maxRevisions. Anything among them still
   * running belongs to the lap being thrown away: it is recorded when it
   * finishes, since it happened and it cost, but it stores nothing and fires
   * no arrows, and a gate still waiting is failed so it asks again.
   *
   * A node that fails does what its error strategy says: stop the run, try
   * again, or carry a fallback value and go on. See `runNode`. When the run
   * stops, nothing new starts; what is already running finishes and is
   * recorded, a gate still waiting is released, and the first failure is
   * thrown once nothing is left running.
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
    const registry = options.gates ?? sharedGates;

    // Every launch of a node carries the lap it was launched in. A gate
    // sending work back moves everything it un-does to the next lap, so a
    // run still in flight from before can be told from the one replacing
    // it: what it produced is recorded — it happened, and it cost — but it
    // stores nothing and fires no arrows.
    const lap = new Map<string, number>();
    const lapOf = (nodeId: string) => lap.get(nodeId) ?? 0;

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
     * can read the gate's decision. One of them still running belongs to
     * the lap being thrown away, and a gate still waiting is failed so it
     * asks again with the redone content.
     */
    const rework = (target: string) => {
      const again = downstreamOf(target);
      again.add(target);
      for (const id of again) {
        done.delete(id);
        lap.set(id, lapOf(id) + 1);
        for (const edge of outgoing.get(id) ?? []) edgeState.delete(edge.id);
        if (nodeMap.get(id)?.type === 'human_gate') {
          registry.fail(executionId, id, 'Superseded: the work was sent back before a decision was made');
        }
      }
      enqueue(target);
    };

    // What is running, and the first thing that went wrong. After a failure
    // nothing new is launched, but what is already running is left to finish
    // and be recorded — a model call cannot be taken back — and any gate
    // still waiting is released so the run does not hang on a reviewer.
    const inFlight = new Set<Promise<void>>();
    let failure: unknown;
    const fail = (error: unknown) => {
      if (failure !== undefined) return;
      failure = error;
      registry.cancel(executionId, `Run failed: ${error instanceof Error ? error.message : String(error)}`);
    };

    /** Runs one node and, when it is still this lap's run, lets it decide what follows. */
    const launch = (node: WorkflowNode, inputs: NodeInput[]) => {
      const nodeId = node.id;
      const launched = lapOf(nodeId);
      const run: RunState = { executionId, revision: revisions.get(nodeId) ?? 0 };
      // A retrying node records the attempts it gave up on as it goes; the
      // attempt it ended on is recorded below, with the rest of the run.
      const record = (attempt: ExecutionTrace) => {
        this.db.createExecutionTrace({ ...attempt, executionId, nodeId });
        options.onNodeComplete?.(nodeId, attempt);
      };

      const work = (async () => {
        const { trace, selectedHandle, decision } = await this.runNode(node, inputs, context, run, options, record);
        record(trace);

        // Superseded while it ran: the lap it belonged to has been thrown away.
        if (lapOf(nodeId) !== launched) return;

        context[nodeId] = decision ? { output: trace.output, trace, decision } : { output: trace.output, trace };

        // Still failed, so its error strategy is spent — it had no strategy, or
        // it ran out of tries. An arrow out of it has nothing meaningful to
        // carry, so stop here rather than run the rest of the graph on a null.
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
      })();

      const tracked: Promise<void> = work.then(
        () => { inFlight.delete(tracked); },
        (error) => { inFlight.delete(tracked); fail(error); }
      );
      inFlight.add(tracked);
    };

    // Launch everything that is ready, wait for something to finish, and go
    // again. The queue only ever holds nodes an arrow just reached; one that
    // is not ready yet is dropped, and the arrow that resolves last will
    // queue it again.
    for (;;) {
      while (queue.length > 0 && failure === undefined) {
        const nodeId = queue.shift()!;
        if (done.has(nodeId)) continue;

        const node = nodeMap.get(nodeId);
        if (!node) continue;

        const inEdges = forwardIn(nodeId);
        if (inEdges.some(e => (edgeState.get(e.id) ?? 'pending') === 'pending')) continue;

        const takenEdges = inEdges.filter(e => edgeState.get(e.id) === 'taken');
        done.add(nodeId);

        if (inEdges.length > 0 && takenEdges.length === 0) {
          // Every arrow in is dead; their sources are what decided against
          // this path. Listed once each, in arrow order.
          const skippedBy = [...new Set(inEdges.map((e) => e.source))];
          const trace = this.skippedTrace(executionId, skippedBy);
          this.db.createExecutionTrace({ ...trace, executionId, nodeId });
          options.onNodeComplete?.(nodeId, trace);
          resolveOutgoing(node, NO_HANDLE);
          continue;
        }

        launch(
          node,
          takenEdges.map(e => ({ nodeId: e.source, output: context[e.source]?.output }))
        );
      }

      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }

    if (failure !== undefined) throw failure;

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

  /**
   * A node that never ran because every arrow into it came from a path that
   * was not taken. `skippedBy` names the nodes those arrows came from, so the
   * log can say what went the other way rather than only that something did.
   */
  private skippedTrace(runId: string, skippedBy: string[] = []): ExecutionTrace {
    return {
      runId,
      timestamp: Date.now(),
      input: null,
      output: null,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      cost: 0,
      latencyMs: 0,
      status: 'skipped',
      detail: skippedBy.length ? { skippedBy } : undefined
    };
  }

  /**
   * Runs one node and then does what its error strategy says.
   *
   * A retrying node tries again after a growing pause, and every attempt it
   * gave up on goes through `record` — so the log shows the failures as well
   * as the try that worked, and the run history counts them. A node that
   * falls back carries its fallback value and the run goes on, with the
   * error left on the trace so the record still says what it recovered from.
   * A node that says nothing about failure fails, and the run stops there.
   */
  private async runNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext,
    run: RunState,
    options: ExecutionOptions,
    record: (trace: ExecutionTrace) => void
  ): Promise<NodeResult> {
    const policy = errorPolicy(node);
    const tries = policy.strategy === 'retry' ? policy.maxAttempts : 1;
    let result!: NodeResult;

    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) {
        record(result.trace);
        await this.sleep(retryDelayMs(attempt - 1));
      }
      options.onNodeStart?.(node.id);
      result = await this.executeNode(node, inputs, context, run, options);
      if (result.trace.status !== 'error') return result;
    }

    if (policy.strategy === 'default') {
      return {
        ...result,
        trace: { ...result.trace, status: 'success', output: policy.fallbackValue }
      };
    }
    return result;
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
      let detail: TraceDetail | undefined;

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
          // The condition as it reads right now. A workflow edited later must
          // not change what this run says it decided on.
          detail = { condition: (node.data.config as any).condition || 'true', handle: output };
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
          // with the persisted trace. It has been recorded here since before
          // `detail` existed, so the log reads it from here for every run —
          // `detail` carries only the handle it chose.
          input.decision = decision;
          detail = { handle: selectedHandle };
          break;
        }

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

      // The gateway prices every call it serves; there is no other source of
      // a price here, so a call it did not price is recorded at zero.
      const cost = reportedCost ?? 0;

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
          model,
          detail
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
      params: promptParams(config),
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

  /**
   * Decides which arrow out of a branch fires.
   *
   * The condition is read against the same three names a template sees —
   * `input`, `inputs` and `nodes` — so what a prompt interpolates and what a
   * branch tests are the same thing said twice. `input` is text, because that
   * is what a condition compares; `inputs` and `nodes` carry the raw outputs,
   * so `get(nodes, "prompt-123.score")` can reach a field a model reported.
   *
   * Every node also keeps a flat name, which is how conditions were written
   * before there was a `nodes` object. Only ids the parser can read as a name
   * arrive that way — a hyphen is subtraction to it, and the canvas hyphenates
   * every id it mints — so `nodes` is the one that always works.
   */
  private async executeBranchNode(
    node: WorkflowNode,
    inputs: NodeInput[],
    context: ExecutionContext
  ): Promise<string> {
    const config = node.data.config as any;
    const conditionStr: string = config.condition || 'true';

    const byNode: Record<string, unknown> = {};
    for (const [nodeId, nodeCtx] of Object.entries(context)) byNode[nodeId] = nodeCtx.output;

    const byInput: Record<string, unknown> = {};
    for (const i of inputs) byInput[i.nodeId] = i.output;

    const scope: Record<string, unknown> = {
      nodes: byNode,
      inputs: byInput,
      // What arrived on the first arrow into this node.
      input: inputs.length ? asText(inputs[0].output) : ''
    };

    for (const [nodeId, output] of Object.entries(byNode)) {
      scope[nodeId] = asText(output);
      scope[`${nodeId}_output`] = output;
    }

    const result = evaluateCondition(conditionStr, scope);

    // A branch has two arrows, `true` and `false`, and the result names the one
    // that fires. Anything else names an arrow that does not exist, and every
    // path out of the node would quietly die — so say so instead.
    if (typeof result !== 'boolean') {
      throw new Error(
        `Branch condition "${conditionStr}" decided ${JSON.stringify(result)} rather than true or false. ` +
        `A branch fires its true arrow or its false arrow, so the condition has to be a comparison — ` +
        `"${conditionStr} > 0" or similar, not a value.`
      );
    }

    return String(result);
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
