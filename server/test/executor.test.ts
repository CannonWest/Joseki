import test from 'node:test';
import assert from 'node:assert/strict';
import { createExampleWorkflow } from '@joseki/shared';
import type { Workflow, WorkflowNode, WorkflowEdge, ExecutionTrace, NodeType } from '@joseki/shared';
import { Database } from '../src/db/database';
import { WorkflowExecutor, type ExecutionOptions } from '../src/engine/executor';

function node(id: string, type: NodeType, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, config: config as any } };
}

function prompt(id: string, userPrompt: string, systemPrompt = ''): WorkflowNode {
  return node(id, 'prompt', { model: 'gpt-4', systemPrompt, userPrompt, temperature: 0, maxTokens: 10 });
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  const id = sourceHandle ? `${source}:${sourceHandle}->${target}` : `${source}->${target}`;
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target };
}

function workflow(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id, name: id, nodes, edges, variables: {}, createdAt: 0, updatedAt: 0 };
}

interface Call { model: string; systemPrompt: string; userPrompt: string }

/** Echoes what it was asked, so a test can see the prompt a node really sent. */
class StubLLM {
  calls: Call[] = [];
  failOn: string | null = null;
  async generate(p: Call) {
    this.calls.push({ model: p.model, systemPrompt: p.systemPrompt, userPrompt: p.userPrompt });
    if (this.failOn && p.userPrompt.includes(this.failOn)) throw new Error(`model refused: ${this.failOn}`);
    return {
      content: `<${p.model}: ${p.userPrompt}>`,
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
      model: p.model
    };
  }
}

function harness(wf: Workflow, options: ExecutionOptions = {}) {
  const db = new Database(':memory:');
  // ':memory:' seeds the example workflow; anything else has to be inserted
  // for the executions foreign key.
  if (!db.getWorkflow(wf.id)) db.createWorkflow(wf);
  db.createExecution({ id: 'run', workflowId: wf.id, status: 'running', context: {}, startedAt: 0 });

  const llm = new StubLLM();
  const executor = new WorkflowExecutor(db, llm as any);
  const started: string[] = [];
  const completed: Array<{ nodeId: string; status: ExecutionTrace['status'] }> = [];

  const run = () =>
    executor.execute(wf, 'run', {
      ...options,
      onNodeStart: (id) => started.push(id),
      onNodeComplete: (id, trace) => completed.push({ nodeId: id, status: trace.status })
    });

  return { db, llm, run, started, completed };
}

const linear = () =>
  workflow(
    'linear',
    [node('in', 'input', { defaultValue: 'the default' }), prompt('draft', 'Summarize: {{input}}'), node('out', 'output')],
    [edge('in', 'draft'), edge('draft', 'out')]
  );

test('an input node takes the run value first, then its defaultValue', async () => {
  const withValue = harness(linear(), { inputs: { in: 'the article' } });
  const ctx = await withValue.run();
  assert.equal(ctx.in.output, 'the article');

  const withDefault = harness(linear());
  const ctx2 = await withDefault.run();
  assert.equal(ctx2.in.output, 'the default');
});

test('{{input}} in a prompt is the output on the arrow into it', async () => {
  const h = harness(linear(), { inputs: { in: 'the article' } });
  await h.run();
  assert.equal(h.llm.calls[0].userPrompt, 'Summarize: the article');
});

test('a required input with no value fails the run at that node', async () => {
  const wf = linear();
  wf.nodes[0] = node('in', 'input', { required: true });
  const h = harness(wf);
  await assert.rejects(h.run(), /Input "in" is required/);
  assert.deepEqual(h.started, ['in']);
  assert.equal(h.llm.calls.length, 0, 'nothing downstream should have run');
});

test('prompt text is not HTML-escaped on its way to the model', async () => {
  const h = harness(linear(), { inputs: { in: `She said "it's <fine>" & left` } });
  await h.run();
  assert.equal(h.llm.calls[0].userPrompt, `Summarize: She said "it's <fine>" & left`);
});

test('the output node passes its single input through', async () => {
  const h = harness(linear(), { inputs: { in: 'x' } });
  const ctx = await h.run();
  assert.equal(ctx.out.output, ctx.draft.output);
  assert.equal(ctx.out.output, '<gpt-4: Summarize: x>');
});

test('a failed node stops the run and nothing after it runs', async () => {
  const h = harness(linear(), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';
  await assert.rejects(h.run(), /Node "draft" \(draft\) failed: model refused: boom/);
  assert.deepEqual(h.completed.map((c) => c.status), ['success', 'error']);
  assert.ok(!h.started.includes('out'));
});

// in → branch ─true──→ yes ─┐
//             └false─→ no ──┴→ merge → out
const forked = (condition: string) =>
  workflow(
    'forked',
    [
      node('in', 'input'),
      node('branch', 'branch', { condition }),
      prompt('yes', 'yes:{{input}}'),
      prompt('no', 'no:{{input}}'),
      node('merge', 'aggregate', { strategy: 'concat', separator: '|' }),
      node('out', 'output')
    ],
    [
      edge('in', 'branch'),
      edge('branch', 'yes', 'true'),
      edge('branch', 'no', 'false'),
      edge('yes', 'merge'),
      edge('no', 'merge'),
      edge('merge', 'out')
    ]
  );

test('a branch fires only the arrow on the winning handle; the other path is skipped', async () => {
  const h = harness(forked('input == "go"'), { inputs: { in: 'go' } });
  const ctx = await h.run();

  assert.deepEqual(h.started, ['in', 'branch', 'yes', 'merge', 'out']);
  assert.equal(h.completed.find((c) => c.nodeId === 'no')?.status, 'skipped');
  assert.equal(ctx.no, undefined, 'a skipped node has no output');
  // The join saw exactly one input, not the whole run.
  assert.equal(ctx.merge.output, '<gpt-4: yes:true>');
});

test('the same branch takes the other arrow when the condition flips', async () => {
  const h = harness(forked('input == "go"'), { inputs: { in: 'stop' } });
  const ctx = await h.run();
  assert.deepEqual(h.started, ['in', 'branch', 'no', 'merge', 'out']);
  assert.equal(h.completed.find((c) => c.nodeId === 'yes')?.status, 'skipped');
  assert.equal(ctx.out.output, '<gpt-4: no:false>');
});

test('aggregate joins only the arrows into it, in arrow order', async () => {
  const wf = workflow(
    'fan',
    [node('in', 'input'), prompt('a', 'A'), prompt('b', 'B'), node('merge', 'aggregate', { strategy: 'concat', separator: '+' })],
    [edge('in', 'a'), edge('in', 'b'), edge('a', 'merge'), edge('b', 'merge')]
  );
  const h = harness(wf, { inputs: { in: 'ignored by merge' } });
  const ctx = await h.run();
  assert.equal(ctx.merge.output, '<gpt-4: A>+<gpt-4: B>');
});

test('a human gate passes its input through and its trace can be persisted', async () => {
  const wf = workflow(
    'gated',
    [node('in', 'input'), node('gate', 'human_gate', { instructions: 'look' }), node('out', 'output')],
    [edge('in', 'gate'), edge('gate', 'out', 'pass')]
  );
  const h = harness(wf, { inputs: { in: 'reviewed text' } });
  const ctx = await h.run();
  assert.equal(ctx.gate.output, 'reviewed text');
  assert.equal(ctx.out.output, 'reviewed text');
  assert.equal(ctx.gate.trace.status, 'success');
});

test('an arrow drawn from a gate with no handle counts as its pass output', async () => {
  const wf = workflow(
    'legacy-gate',
    [node('in', 'input'), node('gate', 'human_gate', {}), node('out', 'output')],
    [edge('in', 'gate'), edge('gate', 'out')]
  );
  const h = harness(wf, { inputs: { in: 'x' } });
  const ctx = await h.run();
  assert.equal(ctx.out.output, 'x');
});

test('a fail arrow out of a gate is not taken while every gate passes', async () => {
  const wf = workflow(
    'gate-fail-arrow',
    [node('in', 'input'), node('gate', 'human_gate', {}), node('ok', 'output'), node('rejected', 'output')],
    [edge('in', 'gate'), edge('gate', 'ok', 'pass'), edge('gate', 'rejected', 'fail')]
  );
  const h = harness(wf, { inputs: { in: 'x' } });
  const ctx = await h.run();
  assert.equal(ctx.ok.output, 'x');
  assert.equal(h.completed.find((c) => c.nodeId === 'rejected')?.status, 'skipped');
});

test('the example workflow runs to the end and Final Output is what the editor reviewed', async () => {
  const wf = createExampleWorkflow();
  const h = harness(wf, { inputs: { example_input: 'An article about rivers.' } });
  const ctx = await h.run();

  // Draft really receives the article now.
  assert.equal(h.llm.calls[0].userPrompt, 'An article about rivers.');
  // Quality Check is hard-wired to "Needs Revision", so the skip path never runs.
  assert.equal(ctx.example_quality_check.output, 'false');
  assert.ok(h.started.includes('example_revision'));
  // Merge joins the one path that ran; the gate hands it on; Final Output shows it.
  assert.equal(ctx.example_merge.output, ctx.example_revision.output);
  assert.equal(ctx.example_editor_review.output, ctx.example_merge.output);
  assert.equal(ctx.example_output.output, ctx.example_merge.output);
  assert.equal(h.completed.at(-1)?.nodeId, 'example_output');
});
