import { Parser } from 'expr-eval';
import type { ExecutionContext, Workflow, WorkflowNode } from '@maestroai/shared';
import { generateId, validateWorkflow } from '@maestroai/shared';
import { WorkflowExecutor } from '../engine/executor';
import { ToolRegistry, fail, ok, type ToolContext, type ToolDefinition } from './registry';

/**
 * The built-in tools. `run_workflow` is the point of the tool loop — chat
 * can drive the workflows built on the canvas — and `list_workflows` tells
 * the model what exists and what each one's inputs are called. The other two
 * are small, deterministic demos.
 */

const inputNodes = (workflow: Workflow): WorkflowNode[] =>
  workflow.nodes.filter((node) => node.type === 'input');

const describeInputs = (workflow: Workflow): string => {
  const names = inputNodes(workflow).map((node) => `"${node.data.label}"`);
  return names.length ? names.join(', ') : 'none';
};

export const listWorkflows: ToolDefinition = {
  name: 'list_workflows',
  description:
    'List the stored MaestroAI workflows: name, id, node count and the names of their input nodes (the keys run_workflow expects).',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, { db }) {
    const workflows = db.getAllWorkflows();
    if (workflows.length === 0) return ok('No workflows are stored yet.');
    const lines = workflows.map((workflow) => {
      const types = new Map<string, number>();
      for (const node of workflow.nodes) types.set(node.type, (types.get(node.type) ?? 0) + 1);
      const summary = [...types.entries()].map(([type, n]) => (n > 1 ? `${type} ×${n}` : type)).join(', ');
      return `- "${workflow.name}" (id ${workflow.id}; ${workflow.nodes.length} nodes: ${summary}; inputs: ${describeInputs(workflow)})`;
    });
    return ok(`${workflows.length} workflow(s):\n${lines.join('\n')}`);
  }
};

export const runWorkflow: ToolDefinition = {
  name: 'run_workflow',
  description:
    'Run a stored MaestroAI workflow and return what it produced. Give the workflow by name or id, and its inputs as an object keyed by input-node name (see list_workflows). Prompt nodes call the configured LLM; a node that fails is reported, not fatal.',
  parameters: {
    type: 'object',
    properties: {
      workflow: { type: 'string', description: 'Workflow name (exact, case-insensitive) or id' },
      inputs: {
        type: 'object',
        description: 'Values for the workflow\'s input nodes, keyed by input-node name (or id). Inputs left out are empty.',
        additionalProperties: { type: 'string' }
      }
    },
    required: ['workflow'],
    additionalProperties: false
  },
  async execute(args, context) {
    const { db } = context;
    const ref = typeof args.workflow === 'string' ? args.workflow.trim() : '';
    if (!ref) return fail('run_workflow needs a workflow name or id.', 'invalid_arguments');

    const workflow = findWorkflow(db.getAllWorkflows(), ref);
    if (!workflow) {
      const names = db.getAllWorkflows().map((w) => `"${w.name}"`).join(', ') || 'none';
      return fail(`No workflow named or with id "${ref}". Stored workflows: ${names}.`, 'not_found');
    }

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      return fail(`Workflow "${workflow.name}" cannot run: ${validation.errors.join('; ')}`, 'invalid_workflow');
    }

    const seeded = seedInputs(workflow, args.inputs);
    if ('error' in seeded) return fail(seeded.error, 'invalid_arguments');

    let executor: WorkflowExecutor;
    try {
      executor = context.createExecutor ? context.createExecutor() : new WorkflowExecutor(db);
    } catch (error) {
      return fail(`The workflow engine could not start: ${message(error)}`, 'engine_unavailable');
    }

    const executionId = generateId();
    const startedAt = Date.now();
    db.createExecution({
      id: executionId,
      workflowId: workflow.id,
      status: 'running',
      context: seeded.context,
      startedAt
    });

    let result: ExecutionContext;
    try {
      result = await executor.execute(workflow, executionId, { context: seeded.context });
    } catch (error) {
      db.updateExecutionStatus(executionId, 'error', message(error), Date.now());
      return fail(`Workflow "${workflow.name}" failed: ${message(error)}`, 'execution_error');
    }
    db.updateExecutionStatus(executionId, 'success', undefined, Date.now());

    return formatWorkflowResult(workflow, result, Date.now() - startedAt);
  }
};

export const calculate: ToolDefinition = {
  name: 'calculate',
  description: 'Evaluate an arithmetic expression, e.g. "2 * (3 + 4)" or "sqrt(2) ^ 2". No variables.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'The expression to evaluate' } },
    required: ['expression'],
    additionalProperties: false
  },
  async execute(args) {
    const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
    if (!expression) return fail('calculate needs an expression.', 'invalid_arguments');
    try {
      const value = new Parser().evaluate(expression);
      return ok(`${expression} = ${String(value)}`);
    } catch (error) {
      return fail(`Could not evaluate "${expression}": ${message(error)}`, 'evaluation_error');
    }
  }
};

export const currentTime: ToolDefinition = {
  name: 'current_time',
  description: 'The current date and time, in UTC and optionally in an IANA time zone such as "America/New_York".',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'IANA time zone name (optional)' } },
    additionalProperties: false
  },
  async execute(args) {
    const now = new Date();
    const lines = [`UTC: ${now.toISOString()}`];
    const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
    if (timezone) {
      try {
        const local = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long'
        }).format(now);
        lines.push(`${timezone}: ${local}`);
      } catch {
        return fail(`Unknown time zone "${timezone}".`, 'invalid_arguments');
      }
    }
    return ok(lines.join('\n'));
  }
};

/** The registry the server starts with. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry().register(listWorkflows).register(runWorkflow).register(calculate).register(currentTime);
}

// ==================== helpers ====================

function findWorkflow(workflows: Workflow[], ref: string): Workflow | undefined {
  const byId = workflows.find((workflow) => workflow.id === ref);
  if (byId) return byId;
  const wanted = ref.toLowerCase();
  return workflows.find((workflow) => workflow.name.toLowerCase() === wanted);
}

/** Pre-fill the execution context so each input node yields its value. */
function seedInputs(
  workflow: Workflow,
  raw: unknown
): { context: ExecutionContext } | { error: string } {
  const inputs = inputNodes(workflow);
  const provided: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(provided)) {
    const wanted = key.trim().toLowerCase();
    const node = inputs.find((n) => n.id === key || n.data.label.trim().toLowerCase() === wanted);
    if (!node) {
      return {
        error: `Workflow "${workflow.name}" has no input named "${key}". Its inputs are: ${describeInputs(workflow)}.`
      };
    }
    values.set(node.id, value === undefined || value === null ? '' : String(value));
  }

  const context: ExecutionContext = {};
  const timestamp = Date.now();
  for (const node of inputs) {
    const output = values.get(node.id) ?? '';
    context[node.id] = {
      output,
      trace: {
        runId: '',
        timestamp,
        input: null,
        output,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        cost: 0,
        latencyMs: 0,
        status: 'success'
      }
    };
  }
  return { context };
}

/**
 * The run, as text for the model: the output-node results first (read from
 * the nodes feeding each output node — the executor's own output-node value
 * is the first successful node's output, which is usually the input), then a
 * per-node roll-call with errors.
 */
function formatWorkflowResult(workflow: Workflow, context: ExecutionContext, elapsedMs: number) {
  const traces = workflow.nodes
    .map((node) => ({ node, entry: context[node.id] }))
    .filter((item) => item.entry !== undefined);
  const failed = traces.filter((item) => item.entry.trace.status === 'error');

  const outputs: string[] = [];
  for (const output of workflow.nodes.filter((node) => node.type === 'output')) {
    const feeders = workflow.edges.filter((edge) => edge.target === output.id).map((edge) => edge.source);
    const values = feeders
      .map((id) => context[id]?.output)
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(asText);
    if (values.length) outputs.push(`Output (${output.data.label}):\n${values.join('\n')}`);
  }
  if (outputs.length === 0) {
    // No output node produced anything: fall back to the last node that did
    // real work (inputs just echo their value; an output node's own value is
    // the executor's first-success pick).
    const last = [...traces]
      .reverse()
      .find(
        (item) =>
          item.entry.trace.status === 'success' &&
          item.node.type !== 'input' &&
          item.node.type !== 'output' &&
          item.entry.output !== undefined &&
          item.entry.output !== null &&
          item.entry.output !== ''
      );
    if (last) outputs.push(`Output (${last.node.data.label}):\n${asText(last.entry.output)}`);
  }

  const rollCall = traces.map(({ node, entry }) => {
    const detail = entry.trace.status === 'error' ? ` — error: ${entry.trace.error ?? 'unknown'}` : '';
    const model = entry.trace.model ? `, ${entry.trace.model}` : '';
    return `- ${node.data.label} (${node.type}${model}): ${entry.trace.status}${detail}`;
  });

  const header = `Workflow "${workflow.name}" ran ${traces.length} node(s) in ${(elapsedMs / 1000).toFixed(1)}s` +
    (failed.length ? `; ${failed.length} failed.` : '.');
  const content = [header, ...outputs, `Nodes:\n${rollCall.join('\n')}`].join('\n\n');

  if (outputs.length === 0 && failed.length > 0) {
    return fail(content, 'workflow_failed');
  }
  return ok(content);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
