import type { Workflow, WorkflowNode, ExecutionContext, ExecutionTrace, NodeType } from '@maestroai/shared';
import { generateId, calculateCost } from '@maestroai/shared';
import Handlebars from 'handlebars';
import { Parser as ExprParser } from 'expr-eval';
import { LLMAdapter } from '../adapters/llm';
import { Database } from '../db/database';

// Create a single parser instance for safe branch condition evaluation
const safeExprParser = new ExprParser();

export interface ExecutionOptions {
  startNodeId?: string;
  context?: ExecutionContext;
  parentExecutionId?: string;
  onNodeStart?: (nodeId: string) => void;
  onNodeComplete?: (nodeId: string, trace: ExecutionTrace) => void;
  onStreamToken?: (nodeId: string, token: string) => void;
}

export class WorkflowExecutor {
  private llmAdapter: LLMAdapter;
  private db: Database;

  constructor(db: Database) {
    this.llmAdapter = new LLMAdapter();
    this.db = db;
  }

  async execute(
    workflow: Workflow,
    executionId: string,
    options: ExecutionOptions = {}
  ): Promise<ExecutionContext> {
    const context: ExecutionContext = options.context || {};
    const executedNodes = new Set<string>();
    
    // Build adjacency list
    const outgoingEdges = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      if (!outgoingEdges.has(edge.source)) {
        outgoingEdges.set(edge.source, []);
      }
      outgoingEdges.get(edge.source)!.push(edge.target);
    }

    // Find start nodes (no incoming edges or specified startNodeId)
    const incomingNodes = new Set(workflow.edges.map(e => e.target));
    const startNodes = options.startNodeId 
      ? [options.startNodeId]
      : workflow.nodes.filter(n => !incomingNodes.has(n.id)).map(n => n.id);

    // Execute in topological order
    const queue = [...startNodes];
    const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      
      if (executedNodes.has(nodeId)) continue;
      
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      // Check if all dependencies are satisfied
      const dependencies = workflow.edges
        .filter(e => e.target === nodeId)
        .map(e => e.source);
      
      const depsSatisfied = dependencies.every(dep => executedNodes.has(dep));
      if (!depsSatisfied) {
        // Put back in queue and try later
        queue.push(nodeId);
        continue;
      }

      // Execute node
      options.onNodeStart?.(nodeId);
      
      const trace = await this.executeNode(node, context, executionId, options);
      
      context[nodeId] = { output: trace.output, trace };
      executedNodes.add(nodeId);

      // Save trace to database
      this.db.createExecutionTrace({ ...trace, executionId, nodeId });
      
      options.onNodeComplete?.(nodeId, trace);

      // Queue next nodes
      const nextNodes = outgoingEdges.get(nodeId) || [];
      for (const nextId of nextNodes) {
        if (!executedNodes.has(nextId)) {
          queue.push(nextId);
        }
      }
    }

    return context;
  }

  private async executeNode(
    node: WorkflowNode,
    context: ExecutionContext,
    runId: string,
    options: ExecutionOptions
  ): Promise<ExecutionTrace> {
    const startTime = Date.now();
    
    try {
      let output: any;
      let tokenUsage = { prompt: 0, completion: 0, total: 0 };
      let model: string | undefined;

      switch (node.type) {
        case 'prompt':
          const promptResult = await this.executePromptNode(
            node, 
            context, 
            options.onStreamToken
          );
          output = promptResult.output;
          tokenUsage = promptResult.tokenUsage;
          model = promptResult.model;
          break;

        case 'branch':
          output = await this.executeBranchNode(node, context);
          break;

        case 'aggregate':
          output = await this.executeAggregateNode(node, context);
          break;

        case 'human_gate':
          output = await this.executeHumanGateNode(node, context);
          break;

        case 'model_compare':
          output = await this.executeModelCompareNode(node, context);
          break;

        case 'input':
          output = context[node.id]?.output || '';
          break;

        case 'output':
          // Get input from connected node
          const inputEdge = Object.entries(context).find(([_, val]) => 
            val.trace.status === 'success'
          );
          output = inputEdge?.[1].output || '';
          break;

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      const latencyMs = Date.now() - startTime;
      
      // Calculate cost if token usage is available
      let cost = 0;
      if (model && tokenUsage.total > 0) {
        const modelConfig = this.getModelConfig(model);
        if (modelConfig) {
          cost = calculateCost(tokenUsage, modelConfig.pricing);
        }
      }

      return {
        runId,
        timestamp: startTime,
        input: this.buildNodeInput(node, context),
        output,
        tokenUsage,
        cost,
        latencyMs,
        status: 'success',
        model
      };

    } catch (error) {
      return {
        runId,
        timestamp: startTime,
        input: this.buildNodeInput(node, context),
        output: null,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        cost: 0,
        latencyMs: Date.now() - startTime,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async executePromptNode(
    node: WorkflowNode,
    context: ExecutionContext,
    onStreamToken?: (nodeId: string, token: string) => void
  ): Promise<{ output: string; tokenUsage: any; model: string }> {
    const config = node.data.config as any;
    
    // Compile templates with context
    const systemTemplate = Handlebars.compile(config.systemPrompt);
    const userTemplate = Handlebars.compile(config.userPrompt);
    
    const systemPrompt = systemTemplate({ nodes: context });
    const userPrompt = userTemplate({ nodes: context });

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
      model: config.model
    };
  }

  private async executeBranchNode(
    node: WorkflowNode,
    context: ExecutionContext
  ): Promise<string> {
    const config = node.data.config as any;
    const conditionStr: string = config.condition || 'true';

    // Build a flat evaluation scope from the execution context.
    // This gives expressions access to node outputs without arbitrary code execution.
    const scope: Record<string, any> = {};

    for (const [nodeId, nodeCtx] of Object.entries(context)) {
      const output = nodeCtx.output;
      scope[nodeId] = typeof output === 'string' ? output : JSON.stringify(output);
      scope[`${nodeId}_output`] = output;
    }

    // Expose a simple "input" key pointing to the first upstream output
    const firstInput = Object.values(context)[0]?.output;
    if (firstInput !== undefined) {
      scope['input'] = typeof firstInput === 'string' ? firstInput : JSON.stringify(firstInput);
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
    context: ExecutionContext
  ): Promise<any> {
    const config = node.data.config as any;
    const outputs = Object.values(context).map(c => c.output);
    
    switch (config.strategy) {
      case 'concat':
        return outputs.join(config.separator || '\n');
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

  private async executeHumanGateNode(
    node: WorkflowNode,
    context: ExecutionContext
  ): Promise<any> {
    // Human gate pauses execution - return current context
    // In real implementation, this would set execution status to 'paused'
    // and wait for human input via WebSocket
    return { paused: true, context };
  }

  private async executeModelCompareNode(
    node: WorkflowNode,
    context: ExecutionContext
  ): Promise<any> {
    const config = node.data.config as any;
    const promptTemplate = Handlebars.compile(config.prompt);
    const prompt = promptTemplate({ nodes: context });

    const results = await Promise.all(
      config.models.map(async (model: string) => {
        const result = await this.llmAdapter.generate({
          model,
          systemPrompt: '',
          userPrompt: prompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens
        });
        return { model, ...result };
      })
    );

    return { comparisons: results };
  }

  private buildNodeInput(node: WorkflowNode, context: ExecutionContext): any {
    // Build input object from context
    return { nodes: context };
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
