import test from 'node:test';
import assert from 'node:assert/strict';
import type { Workflow, WorkflowEdge, WorkflowNode } from '@maestroai/shared';
import { Database } from '../src/db/database';
import { WorkflowExecutor } from '../src/engine/executor';
import type { LLMAdapter } from '../src/adapters/llm';
import { calculate, createDefaultRegistry, currentTime, listWorkflows, runWorkflow } from '../src/tools/builtins';
import type { ToolContext } from '../src/tools/registry';

const node = (id: string, type: WorkflowNode['type'], label: string, config: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config: config as WorkflowNode['data']['config'] }
});
const edge = (id: string, source: string, target: string): WorkflowEdge => ({ id, source, target });
const workflow = (id: string, name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({
  id,
  name,
  nodes,
  edges,
  variables: {},
  createdAt: 1,
  updatedAt: 1
});

/** input → aggregate(concat) → output: runs without any LLM. */
const echoFlow = workflow(
  'wf-echo',
  'Echo Flow',
  [
    node('q', 'input', 'Question', { inputType: 'text' }),
    node('agg', 'aggregate', 'Combine', { strategy: 'concat' }),
    node('out', 'output', 'Result')
  ],
  [edge('e1', 'q', 'agg'), edge('e2', 'agg', 'out')]
);

/** input → prompt → output: the prompt node needs an adapter. */
const promptFlow = workflow(
  'wf-prompt',
  'Prompt Flow',
  [
    node('q', 'input', 'Question'),
    node('p', 'prompt', 'Answer', {
      systemPrompt: 'Be brief.',
      userPrompt: 'Q: {{nodes.q.output}}',
      model: 'gpt-4',
      temperature: 0,
      maxTokens: 10
    }),
    node('out', 'output', 'Result')
  ],
  [edge('e1', 'q', 'p'), edge('e2', 'p', 'out')]
);

function fakeAdapter(reply: (userPrompt: string) => string): LLMAdapter {
  return {
    async generate({ userPrompt, model }: { userPrompt: string; model: string }) {
      return { content: reply(userPrompt), tokenUsage: { prompt: 1, completion: 1, total: 2 }, model };
    }
  } as unknown as LLMAdapter;
}

function setup(adapter: LLMAdapter = fakeAdapter((p) => `echo:${p}`)) {
  const db = new Database(':memory:');
  db.createWorkflow(echoFlow);
  db.createWorkflow(promptFlow);
  const context: ToolContext = {
    db,
    conversationId: 'c1',
    createExecutor: () => new WorkflowExecutor(db, adapter)
  };
  return { db, context };
}

test('the default registry offers the four builtins', () => {
  assert.deepEqual(
    createDefaultRegistry().assemble().map((t) => t.function.name),
    ['list_workflows', 'run_workflow', 'calculate', 'current_time']
  );
});

test('calculate evaluates arithmetic and reports bad input', async () => {
  const { context } = setup();
  assert.deepEqual(await calculate.execute({ expression: '2 * (3 + 4)' }, context), {
    content: '2 * (3 + 4) = 14',
    isError: false
  });
  const bad = await calculate.execute({ expression: '2 +' }, context);
  assert.equal(bad.isError, true);
  assert.equal(bad.errorType, 'evaluation_error');
  const missing = await calculate.execute({}, context);
  assert.equal(missing.errorType, 'invalid_arguments');
});

test('current_time reports UTC and an optional zone', async () => {
  const { context } = setup();
  const utc = await currentTime.execute({}, context);
  assert.equal(utc.isError, false);
  assert.match(utc.content, /^UTC: \d{4}-\d{2}-\d{2}T/);

  const zoned = await currentTime.execute({ timezone: 'America/New_York' }, context);
  assert.match(zoned.content, /America\/New_York: /);

  const bad = await currentTime.execute({ timezone: 'Mars/Olympus' }, context);
  assert.equal(bad.errorType, 'invalid_arguments');
});

test('list_workflows names each workflow with its inputs', async () => {
  const { db, context } = setup();
  const result = await listWorkflows.execute({}, context);
  assert.equal(result.isError, false);
  assert.match(result.content, /"Echo Flow" \(id wf-echo; 3 nodes: input, aggregate, output; inputs: "Question"\)/);
  assert.match(result.content, /"Prompt Flow"/);
  assert.match(result.content, new RegExp(`"${db.getAllWorkflows().find((w) => w.id !== 'wf-echo' && w.id !== 'wf-prompt')!.name}"`));

  const empty = new Database(':memory:');
  for (const w of empty.getAllWorkflows()) empty.deleteWorkflow(w.id);
  assert.equal((await listWorkflows.execute({}, { ...context, db: empty })).content, 'No workflows are stored yet.');
});

test('run_workflow runs a stored workflow by name and returns the output', async () => {
  const { db, context } = setup();
  const result = await runWorkflow.execute({ workflow: 'echo flow', inputs: { question: 'pong' } }, context);
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /^Workflow "Echo Flow" ran 3 node\(s\) in \d+\.\ds\./);
  assert.match(result.content, /Output \(Result\):\npong/);
  assert.match(result.content, /- Question \(input\): success/);
  assert.match(result.content, /- Combine \(aggregate\): success/);
  // the run is on record
  const traces = (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
    .prepare('SELECT node_id FROM execution_traces')
    .all();
  assert.equal(traces.length, 3);
});

test('run_workflow accepts the id and an input keyed by node id', async () => {
  const { context } = setup();
  const result = await runWorkflow.execute({ workflow: 'wf-echo', inputs: { q: 'by id' } }, context);
  assert.equal(result.isError, false);
  assert.match(result.content, /Output \(Result\):\nby id/);
});

test('run_workflow feeds prompt nodes through the engine and reports their model', async () => {
  const { context } = setup(fakeAdapter((prompt) => `answer to [${prompt}]`));
  const result = await runWorkflow.execute({ workflow: 'Prompt Flow', inputs: { Question: 'why?' } }, context);
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /Output \(Result\):\nanswer to \[Q: why\?\]/);
  assert.match(result.content, /- Answer \(prompt, gpt-4\): success/);
});

test('run_workflow reports a failed node instead of throwing', async () => {
  const { context } = setup({
    async generate() {
      throw new Error('adapter down');
    }
  } as unknown as LLMAdapter);
  const result = await runWorkflow.execute({ workflow: 'Prompt Flow', inputs: { Question: 'x' } }, context);
  assert.equal(result.isError, true);
  assert.equal(result.errorType, 'workflow_failed');
  assert.match(result.content, /1 failed\./);
  assert.match(result.content, /- Answer \(prompt\): error — error: adapter down/);
});

test('run_workflow explains unknown workflows, unknown inputs and missing arguments', async () => {
  const { context } = setup();

  const missing = await runWorkflow.execute({}, context);
  assert.equal(missing.errorType, 'invalid_arguments');

  const unknown = await runWorkflow.execute({ workflow: 'Nope' }, context);
  assert.equal(unknown.errorType, 'not_found');
  assert.match(unknown.content, /Stored workflows: .*"Echo Flow".*"Prompt Flow"/);

  const badInput = await runWorkflow.execute({ workflow: 'Echo Flow', inputs: { Answer: 'x' } }, context);
  assert.equal(badInput.errorType, 'invalid_arguments');
  assert.match(badInput.content, /has no input named "Answer". Its inputs are: "Question"\./);
});

test('run_workflow refuses a workflow that cannot run', async () => {
  const { db, context } = setup();
  db.createWorkflow(
    workflow('wf-loop', 'Loop Flow', [node('a', 'aggregate', 'A'), node('b', 'aggregate', 'B')], [
      edge('e1', 'a', 'b'),
      edge('e2', 'b', 'a')
    ])
  );
  const result = await runWorkflow.execute({ workflow: 'Loop Flow' }, context);
  assert.equal(result.errorType, 'invalid_workflow');
  assert.match(result.content, /cannot run/);
});

test('run_workflow reports an engine that cannot start', async () => {
  const { context } = setup();
  const result = await runWorkflow.execute(
    { workflow: 'Echo Flow' },
    {
      ...context,
      createExecutor: () => {
        throw new Error('The OPENAI_API_KEY environment variable is missing');
      }
    }
  );
  assert.equal(result.errorType, 'engine_unavailable');
  assert.match(result.content, /OPENAI_API_KEY/);
});
