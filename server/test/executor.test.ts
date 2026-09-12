import test from 'node:test';
import assert from 'node:assert/strict';
import { createExampleWorkflow } from '@joseki/shared';
import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  ExecutionTrace,
  ExecutionPausedEvent,
  GateDecision,
  NodeType
} from '@joseki/shared';
import { Database } from '../src/db/database';
import { WorkflowExecutor, type ExecutionOptions } from '../src/engine/executor';
import { GateRegistry } from '../src/engine/gates';

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
  /** Cost the fake gateway reports; undefined means it reported none. */
  cost: number | undefined = undefined;
  async generate(p: Call) {
    this.calls.push({ model: p.model, systemPrompt: p.systemPrompt, userPrompt: p.userPrompt });
    if (this.failOn && p.userPrompt.includes(this.failOn)) throw new Error(`model refused: ${this.failOn}`);
    return {
      content: `<${p.model}: ${p.userPrompt}>`,
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
      model: p.model,
      cost: this.cost
    };
  }
}

type Decide = (event: ExecutionPausedEvent, index: number, gates: GateRegistry) => GateDecision | undefined;

/** Every pause gets `decide`'s answer on the next tick; undefined leaves the gate waiting. */
function harness(wf: Workflow, options: ExecutionOptions = {}, decide?: Decide) {
  const db = new Database(':memory:');
  // ':memory:' seeds the example workflow; anything else has to be inserted
  // for the executions foreign key.
  if (!db.getWorkflow(wf.id)) db.createWorkflow(wf);
  db.createExecution({ id: 'run', workflowId: wf.id, status: 'running', context: {}, startedAt: 0 });

  const llm = new StubLLM();
  const gates = new GateRegistry();
  const executor = new WorkflowExecutor(db, llm as any);
  const started: string[] = [];
  const completed: Array<{ nodeId: string; status: ExecutionTrace['status'] }> = [];
  const paused: ExecutionPausedEvent[] = [];

  const run = () =>
    executor.execute(wf, 'run', {
      ...options,
      gates,
      onNodeStart: (id) => started.push(id),
      onNodeComplete: (id, trace) => completed.push({ nodeId: id, status: trace.status }),
      onPaused: (event) => {
        const index = paused.push(event) - 1;
        setImmediate(() => {
          const decision = decide?.(event, index, gates);
          if (decision) gates.resolve(event.executionId, event.nodeId, decision);
        });
      }
    });

  return { db, llm, gates, run, started, completed, paused };
}

const pass: Decide = () => ({ verdict: 'pass' });

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

test('a prompt trace carries the gateway cost when reported, else the local price table', async () => {
  const reported = harness(linear(), { inputs: { in: 'x' } });
  reported.llm.cost = 0.00042;
  assert.equal((await reported.run()).draft.trace.cost, 0.00042);

  // gpt-4 is in the local table: 1 prompt token + 1 completion token.
  const local = harness(linear(), { inputs: { in: 'x' } });
  const ctx = await local.run();
  assert.equal(ctx.draft.trace.cost, Number(((1 / 1000) * 0.03 + (1 / 1000) * 0.06).toFixed(6)));
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

// ---------------------------------------------------------------- human gate

// in → gate ─pass─→ ok
//           └fail─→ rejected
const gated = (config: Record<string, unknown> = {}) =>
  workflow(
    'gated',
    [node('in', 'input'), node('gate', 'human_gate', { instructions: 'look', ...config }), node('ok', 'output'), node('rejected', 'output')],
    [edge('in', 'gate'), edge('gate', 'ok', 'pass'), edge('gate', 'rejected', 'fail')]
  );

test('a human gate pauses the run with the content under review; pass sends it on', async () => {
  const h = harness(gated({ maxRevisions: 2 }), { inputs: { in: 'reviewed text' } }, pass);
  const ctx = await h.run();

  assert.equal(h.paused.length, 1);
  assert.deepEqual(h.paused[0], {
    executionId: 'run',
    nodeId: 'gate',
    content: 'reviewed text',
    instructions: 'look',
    allowEdit: false,
    revision: 0,
    maxRevisions: 2
  });
  assert.equal(ctx.gate.output, 'reviewed text');
  assert.equal(ctx.gate.decision?.verdict, 'pass');
  assert.equal(ctx.gate.trace.input.decision.verdict, 'pass', 'the decision is persisted with the trace');
  assert.equal(ctx.ok.output, 'reviewed text');
  assert.equal(h.completed.find((c) => c.nodeId === 'rejected')?.status, 'skipped');
});

test('an edit on pass replaces the content when the gate allows it, and is ignored when it does not', async () => {
  const edit: Decide = () => ({ verdict: 'pass', edited: 'the fixed text' });

  const editable = harness(gated({ allowEdit: true }), { inputs: { in: 'draft text' } }, edit);
  assert.equal((await editable.run()).ok.output, 'the fixed text');

  const locked = harness(gated({ allowEdit: false }), { inputs: { in: 'draft text' } }, edit);
  assert.equal((await locked.run()).ok.output, 'draft text');
});

test('fail takes the fail arrows and the pass path is skipped', async () => {
  const h = harness(gated(), { inputs: { in: 'weak text' } }, () => ({ verdict: 'fail', note: 'too short' }));
  const ctx = await h.run();
  assert.equal(ctx.rejected.output, 'weak text', 'the content still travels down the fail arrow');
  assert.equal(h.completed.find((c) => c.nodeId === 'ok')?.status, 'skipped');
  assert.equal(ctx.gate.decision?.note, 'too short');
});

test('an arrow drawn from a gate with no handle counts as its pass output', async () => {
  const wf = workflow(
    'legacy-gate',
    [node('in', 'input'), node('gate', 'human_gate', {}), node('out', 'output')],
    [edge('in', 'gate'), edge('gate', 'out')]
  );
  const h = harness(wf, { inputs: { in: 'x' } }, pass);
  const ctx = await h.run();
  assert.equal(ctx.out.output, 'x');
});

test('fail at a gate with no fail arrow ends the run as rejected', async () => {
  const wf = workflow(
    'no-fail-arrow',
    [node('in', 'input'), node('gate', 'human_gate', {}), node('out', 'output')],
    [edge('in', 'gate'), edge('gate', 'out', 'pass')]
  );
  const h = harness(wf, { inputs: { in: 'x' } }, () => ({ verdict: 'fail' }));
  await assert.rejects(h.run(), /Rejected at "gate" \(gate\): the gate has no fail arrow/);
  assert.ok(!h.started.includes('out'));
});

// in → draft → gate ─pass─→ out
//        ↑           └fail─┘   (sends the work back)
const loop = (gateConfig: Record<string, unknown> = {}) =>
  workflow(
    'loop',
    [
      node('in', 'input'),
      prompt('draft', 'D:{{input}}|{{nodes.gate.decision.note}}'),
      node('gate', 'human_gate', { instructions: 'review', ...gateConfig }),
      node('out', 'output')
    ],
    [edge('in', 'draft'), edge('draft', 'gate'), edge('gate', 'out', 'pass'), edge('gate', 'draft', 'fail')]
  );

test('a fail arrow pointing back re-runs the target and everything after it, then the gate asks again', async () => {
  const decisions: GateDecision[] = [{ verdict: 'fail', note: 'shorter' }, { verdict: 'pass' }];
  const h = harness(loop(), { inputs: { in: 'article' } }, (_e, i) => decisions[i]);
  const ctx = await h.run();

  assert.deepEqual(h.started, ['in', 'draft', 'gate', 'draft', 'gate', 'out'], 'the input is not re-run');
  assert.equal(h.paused[0].revision, 0);
  assert.equal(h.paused[1].revision, 1);
  // The first lap has no note yet; the second lap can read the rejection.
  assert.deepEqual(h.llm.calls.map((c) => c.userPrompt), ['D:article|', 'D:article|shorter']);
  // The back arrow triggers the re-run but does not feed the node.
  assert.deepEqual(Object.keys(ctx.draft.trace.input.inputs), ['in']);
  assert.equal(ctx.out.output, '<gpt-4: D:article|shorter>');
  assert.equal(ctx.gate.decision?.verdict, 'pass');
});

test('maxRevisions bounds the loop', async () => {
  const h = harness(loop({ maxRevisions: 1 }), { inputs: { in: 'article' } }, () => ({ verdict: 'fail' }));
  await assert.rejects(h.run(), /"gate" \(gate\) sent the work back 2 times; maxRevisions is 1/);
  assert.equal(h.started.filter((id) => id === 'draft').length, 2, 'one original run plus one revision');
  assert.ok(!h.started.includes('out'));
});

test('a gate nobody answers fails the run when its timeout passes', async () => {
  const h = harness(gated({ timeout: 0.02 }), { inputs: { in: 'x' } }, () => undefined);
  await assert.rejects(h.run(), /Node "gate" \(gate\) failed: No decision within/);
  assert.deepEqual(h.gates.pending(), [], 'the waiter is released');
});

test('cancelling the run fails the gate it is waiting at', async () => {
  const h = harness(gated(), { inputs: { in: 'x' } }, (event, _i, gates) => {
    gates.cancel(event.executionId, 'Cancelled by user');
    return undefined;
  });
  await assert.rejects(h.run(), /Node "gate" \(gate\) failed: Cancelled by user/);
  assert.deepEqual(h.gates.pending(), []);
});

test('the example workflow runs to the end and Final Output is what the editor approved', async () => {
  const wf = createExampleWorkflow();
  const h = harness(wf, { inputs: { example_input: 'An article about rivers.' } }, pass);
  const ctx = await h.run();

  // Draft really receives the article now.
  assert.equal(h.llm.calls[0].userPrompt, 'An article about rivers.');
  // Quality Check is hard-wired to "Needs Revision", so the skip path never runs.
  assert.equal(ctx.example_quality_check.output, 'false');
  assert.ok(h.started.includes('example_revision'));
  // Merge joins the one path that ran; the editor approves it; Final Output shows it.
  assert.equal(ctx.example_merge.output, ctx.example_revision.output);
  assert.equal(h.paused[0].content, ctx.example_merge.output);
  assert.equal(ctx.example_editor_review.output, ctx.example_merge.output);
  assert.equal(ctx.example_output.output, ctx.example_merge.output);
  assert.equal(h.completed.at(-1)?.nodeId, 'example_output');
});
