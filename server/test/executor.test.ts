import test from 'node:test';
import assert from 'node:assert/strict';
import { createBestOfFour, createExampleWorkflow, MAX_ATTEMPTS } from '@joseki/shared';
import type {
  ChatParams,
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
  return { id, name: id, folder: '', nodes, edges, variables: {}, createdAt: 0, updatedAt: 0 };
}

interface Call { model: string; systemPrompt: string; userPrompt: string; params?: ChatParams }

/** Echoes what it was asked, so a test can see the prompt — and the settings — a node really sent. */
class StubLLM {
  calls: Call[] = [];
  failOn: string | null = null;
  /** Refusals before it relents; null refuses every time. */
  failTimes: number | null = null;
  private refusals = 0;
  /** Cost the fake gateway reports; undefined means it reported none. */
  cost: number | undefined = undefined;
  /** When set, every call waits here until released, so a test can see what is in flight. */
  hold = false;
  private held: Array<{ prompt: string; release: () => void }> = [];
  /** Lets held calls go: those whose prompt `pick` accepts, or all of them. */
  release(pick: (prompt: string) => boolean = () => true) {
    const going = this.held.filter((h) => pick(h.prompt));
    this.held = this.held.filter((h) => !pick(h.prompt));
    for (const h of going) h.release();
  }
  async generate(p: Call) {
    this.calls.push({ model: p.model, systemPrompt: p.systemPrompt, userPrompt: p.userPrompt, params: p.params });
    if (this.hold) await new Promise<void>((release) => this.held.push({ prompt: p.userPrompt, release }));
    const refusing =
      this.failOn !== null &&
      p.userPrompt.includes(this.failOn) &&
      (this.failTimes === null || this.refusals < this.failTimes);
    if (refusing) {
      this.refusals++;
      throw new Error(`model refused: ${this.failOn}`);
    }
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
  // Retries wait in real life; here the wait is only written down.
  const waits: number[] = [];
  const executor = new WorkflowExecutor(db, llm as any, async (ms) => {
    waits.push(ms);
  });
  const started: string[] = [];
  const completed: Array<{ nodeId: string; status: ExecutionTrace['status'] }> = [];
  const paused: ExecutionPausedEvent[] = [];

  // The gate registry unrefs its timeout timer on purpose (gates.ts): a waiting
  // gate must not keep a server process alive by itself, because the HTTP
  // server's own handle already does. This process has no server. With the
  // executor's sleep faked (above) and onPaused's setImmediate spent, a run
  // waiting on a gate leaves NOTHING ref'd, so Node reaches beforeExit, and
  // node:test cancels the still-pending test and every test after it in the
  // file: "Promise resolution is still pending but the event loop has already
  // resolved". It passed on a laptop only because tsx/stdout held a handle a
  // few hundred microseconds longer than the 20 ms gate timeout; on the CI
  // runner they did not (duration_ms 19.55 of 20). One ref'd interval for the
  // run's lifetime plays the server's part; the gate's own timer still decides.
  const run = async () => {
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      return await executor.execute(wf, 'run', {
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
    } finally {
      clearInterval(keepAlive);
    }
  };

  return { db, llm, gates, run, started, completed, paused, waits };
}

const pass: Decide = () => ({ verdict: 'pass' });

/** Spins the event loop until `condition` holds, and fails the test if it never does. */
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), `never happened: ${what}`);
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

test('{{vars.x}} in a prompt is what the workflow declared', async () => {
  const wf = linear();
  wf.variables = { tone: 'dry' };
  const draft = wf.nodes.find((n) => n.id === 'draft')!;
  (draft.data.config as any).userPrompt = 'Summarize in a {{vars.tone}} tone: {{input}}';
  const h = harness(wf, { inputs: { in: 'the article' } });
  await h.run();
  assert.equal(h.llm.calls[0].userPrompt, 'Summarize in a dry tone: the article');
});

test('a workflow that declares nothing renders {{vars.x}} as empty rather than failing', async () => {
  const wf = linear();
  const draft = wf.nodes.find((n) => n.id === 'draft')!;
  (draft.data.config as any).userPrompt = 'Tone: {{vars.tone}}.';
  const h = harness(wf, { inputs: { in: 'x' } });
  await h.run();
  assert.equal(h.llm.calls[0].userPrompt, 'Tone: .');
});

test('a run may be given variables of its own, overriding what the workflow declares', async () => {
  const wf = linear();
  wf.variables = { tone: 'dry' };
  const draft = wf.nodes.find((n) => n.id === 'draft')!;
  (draft.data.config as any).userPrompt = '{{vars.tone}}';
  const h = harness(wf, { inputs: { in: 'x' }, variables: { tone: 'florid' } });
  await h.run();
  assert.equal(h.llm.calls[0].userPrompt, 'florid');
});

test('a branch reads a declared number as a number', async () => {
  // Declared values are not coerced to text on the way in: 10 > 9 numerically,
  // where "10" > "9" — the comparison text would give — is false.
  const wf = workflow(
    'branching',
    [
      node('in', 'input', { defaultValue: 'x' }),
      node('gate', 'branch', { condition: 'vars.threshold > 9' }),
      node('hi', 'output'),
      node('lo', 'output')
    ],
    [edge('in', 'gate'), edge('gate', 'hi', 'true'), edge('gate', 'lo', 'false')]
  );
  wf.variables = { threshold: 10 };
  const h = harness(wf);
  const ctx = await h.run();
  assert.equal(ctx.gate.output, 'true');
  assert.ok(ctx.hi, 'the true arrow should have fired');
  assert.ok(!ctx.lo, 'the false arrow should have been skipped');
});

test('a transform computes without a model and carries the answer downstream', async () => {
  const wf = workflow(
    'transforming',
    [
      node('in', 'input', { defaultValue: '{"score": 0.82, "verdict": "keep"}' }),
      node('score', 'transform', { expression: 'get(input, "score")' }),
      prompt('draft', 'Score was {{nodes.score.output}}'),
      node('out', 'output')
    ],
    [edge('in', 'score'), edge('score', 'draft'), edge('draft', 'out')]
  );
  const h = harness(wf);
  const ctx = await h.run();
  assert.equal(ctx.score.output, 0.82, 'the field should arrive as a number, not the JSON around it');
  assert.equal(h.llm.calls.length, 1, 'a transform must not call a model');
  assert.equal(h.llm.calls[0].userPrompt, 'Score was 0.82');
});

test('a transform reads declared variables too', async () => {
  const wf = workflow(
    'transforming',
    [
      node('in', 'input', { defaultValue: '{"score": 0.82}' }),
      node('verdict', 'transform', {
        expression: 'if(get(input, "score") > vars.threshold, "keep", "drop")'
      }),
      node('out', 'output')
    ],
    [edge('in', 'verdict'), edge('verdict', 'out')]
  );
  wf.variables = { threshold: 0.5 };
  const h = harness(wf);
  const ctx = await h.run();
  assert.equal(ctx.verdict.output, 'keep');
});

test('a transform with no expression carries its input through unchanged', async () => {
  const wf = workflow(
    'transforming',
    [node('in', 'input', { defaultValue: 'straight through' }), node('t', 'transform', {}), node('out', 'output')],
    [edge('in', 't'), edge('t', 'out')]
  );
  const ctx = await harness(wf).run();
  assert.equal(ctx.t.output, 'straight through');
});

test('an expression that cannot be evaluated fails the node, under its own error strategy', async () => {
  const wf = workflow(
    'transforming',
    [
      node('in', 'input', { defaultValue: 'x' }),
      node('t', 'transform', { expression: 'nosuchthing(input)' }),
      node('out', 'output')
    ],
    [edge('in', 't'), edge('t', 'out')]
  );
  await assert.rejects(harness(wf).run(), /nosuchthing/);

  // The same node told to fall back carries the fallback and the run goes on,
  // exactly as a prompt node does — error strategy is read off the config
  // whatever the node's type.
  const wf2 = workflow(
    'transforming',
    [
      node('in', 'input', { defaultValue: 'x' }),
      node('t', 'transform', {
        expression: 'nosuchthing(input)',
        onError: { strategy: 'default', fallbackValue: 'fell back' }
      }),
      node('out', 'output')
    ],
    [edge('in', 't'), edge('t', 'out')]
  );
  const ctx = await harness(wf2).run();
  assert.equal(ctx.t.output, 'fell back');
  assert.equal(ctx.out.output, 'fell back');
});

test('a required input with no value fails the run at that node', async () => {
  const wf = linear();
  wf.nodes[0] = node('in', 'input', { required: true });
  const h = harness(wf);
  await assert.rejects(h.run(), /Input "in" is required/);
  assert.deepEqual(h.started, ['in']);
  assert.equal(h.llm.calls.length, 0, 'nothing downstream should have run');
});

test('a prompt node sends its routing, sampling and reasoning along with its prompts', async () => {
  const wf = linear();
  const draft = wf.nodes.find((n) => n.id === 'draft')!;
  Object.assign(draft.data.config, {
    topP: 0.9,
    routing: { only: ['groq'], fallbackModels: ['openai/gpt-4o'] },
    sampling: { topK: 40 },
    reasoning: { effort: 'high' }
  });
  const h = harness(wf, { inputs: { in: 'x' } });
  await h.run();

  const call = h.llm.calls.find((c) => c.userPrompt.startsWith('Summarize'))!;
  assert.deepEqual(call.params, {
    temperature: 0,
    maxTokens: 10,
    topP: 0.9,
    routing: { only: ['groq'], fallbackModels: ['openai/gpt-4o'] },
    sampling: { topK: 40 },
    reasoning: { effort: 'high' }
  });
});

test('a prompt node that set nothing beyond temperature and max tokens sends only those', async () => {
  const h = harness(linear(), { inputs: { in: 'x' } });
  await h.run();
  const call = h.llm.calls.find((c) => c.userPrompt.startsWith('Summarize'))!;
  assert.deepEqual(call.params, { temperature: 0, maxTokens: 10 });
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

test('a prompt trace carries the gateway cost when reported, and zero when it is not', async () => {
  const reported = harness(linear(), { inputs: { in: 'x' } });
  reported.llm.cost = 0.00042;
  assert.equal((await reported.run()).draft.trace.cost, 0.00042);

  // The gateway is the only source of a price. There is no local table to
  // fall back on, so an unpriced call is not guessed at.
  const unpriced = harness(linear(), { inputs: { in: 'x' } });
  const ctx = await unpriced.run();
  assert.equal(ctx.draft.trace.cost, 0);
});

test('a failed node stops the run and nothing after it runs', async () => {
  const h = harness(linear(), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';
  await assert.rejects(h.run(), /Node "draft" \(draft\) failed: model refused: boom/);
  assert.deepEqual(h.completed.map((c) => c.status), ['success', 'error']);
  assert.ok(!h.started.includes('out'));
});

// ---- what a node does about failure: the onError strategies ----

/** in → draft → out, where draft is told what to do when the model refuses. */
const onError = (config: Record<string, unknown>) => {
  const wf = linear();
  const draft = wf.nodes.find((n) => n.id === 'draft')!;
  (draft.data.config as any).onError = config;
  return wf;
};

test('a retrying node tries again, and the run carries on with the try that worked', async () => {
  const h = harness(onError({ strategy: 'retry' }), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';
  h.llm.failTimes = 1;

  const ctx = await h.run();

  assert.equal(ctx.draft.trace.status, 'success');
  assert.equal(ctx.out.output, '<gpt-4: Summarize: boom>');
  // The failure is in the story rather than swallowed, and the node announced
  // itself again so the canvas shows it running a second time.
  assert.deepEqual(h.completed.map((c) => c.status), ['success', 'error', 'success', 'success']);
  assert.deepEqual(h.started, ['in', 'draft', 'draft', 'out']);
  assert.deepEqual(h.waits, [500]);
});

test('every attempt is recorded, so the history shows the failures as well', async () => {
  const h = harness(onError({ strategy: 'retry' }), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';
  h.llm.failTimes = 2;
  await h.run();

  const attempts = h.db.getExecutionTraces('run').filter((t) => t.nodeId === 'draft');
  assert.deepEqual(attempts.map((t) => t.status), ['error', 'error', 'success']);
  assert.match(attempts[0].error ?? '', /model refused/);
  // Each pause is longer than the one before it.
  assert.deepEqual(h.waits, [500, 1000]);
});

test('a retrying node that never works fails the run, after the tries it was given', async () => {
  const h = harness(onError({ strategy: 'retry', maxAttempts: 2 }), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';

  await assert.rejects(h.run(), /Node "draft" \(draft\) failed: model refused: boom/);
  assert.equal(h.llm.calls.length, 2);
  assert.ok(!h.started.includes('out'));
});

test('however many tries a node asks for, it gets at most MAX_ATTEMPTS', async () => {
  const h = harness(onError({ strategy: 'retry', maxAttempts: 99 }), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';

  await assert.rejects(h.run(), /model refused/);
  assert.equal(h.llm.calls.length, MAX_ATTEMPTS);
});

test('a node that falls back carries its fallback value, and the run goes on', async () => {
  const h = harness(
    onError({ strategy: 'default', fallbackValue: 'nothing to summarize' }),
    { inputs: { in: 'boom' } }
  );
  h.llm.failOn = 'boom';

  const ctx = await h.run();

  assert.equal(ctx.draft.output, 'nothing to summarize');
  assert.equal(ctx.out.output, 'nothing to summarize');
  assert.equal(h.llm.calls.length, 1, 'a fallback is not a retry');
  // It succeeded, and the trace still says what it recovered from.
  assert.equal(ctx.draft.trace.status, 'success');
  assert.match(ctx.draft.trace.error ?? '', /model refused: boom/);
});

test('a fallback with nothing to fall back to carries null', async () => {
  const h = harness(onError({ strategy: 'default' }), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';

  const ctx = await h.run();
  assert.equal(ctx.draft.output, null);
});

test('a node with no strategy still stops the run, and never waits', async () => {
  const h = harness(linear(), { inputs: { in: 'boom' } });
  h.llm.failOn = 'boom';

  await assert.rejects(h.run(), /model refused/);
  assert.equal(h.llm.calls.length, 1);
  assert.deepEqual(h.waits, []);
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

test('a branch can route on the size of what reached it', async () => {
  const long = harness(forked('length(input) > 500'), { inputs: { in: 'x'.repeat(640) } });
  await long.run();
  assert.deepEqual(long.started, ['in', 'branch', 'yes', 'merge', 'out']);

  const short = harness(forked('length(input) > 500'), { inputs: { in: 'x'.repeat(499) } });
  await short.run();
  assert.deepEqual(short.started, ['in', 'branch', 'no', 'merge', 'out']);
});

test('a branch can route on a field the model reported', async () => {
  const h = harness(forked('get(input, "score") > 0.5'), {
    inputs: { in: '{"score": 0.82, "verdict": "approved"}' }
  });
  await h.run();
  assert.deepEqual(h.started, ['in', 'branch', 'yes', 'merge', 'out']);
});

test('a branch can route on words and on text it contains', async () => {
  const h = harness(forked('words(input) > 3 and contains(lower(input), "urgent")'), {
    inputs: { in: 'This one is URGENT, please look' }
  });
  await h.run();
  assert.deepEqual(h.started, ['in', 'branch', 'yes', 'merge', 'out']);
});

// in → prompt-1757 → branch ─true──→ yes ─┐
//                          └false─→ no ───┴→ merge → out
// The hyphen is what matters: it is the shape of every id the canvas mints.
const afterHyphenatedNode = (condition: string) =>
  workflow(
    'hyphenated',
    [
      node('in', 'input'),
      prompt('prompt-1757', '{{input}}'),
      node('branch', 'branch', { condition }),
      prompt('yes', 'yes'),
      prompt('no', 'no'),
      node('merge', 'aggregate', { strategy: 'concat' }),
      node('out', 'output')
    ],
    [
      edge('in', 'prompt-1757'),
      edge('prompt-1757', 'branch'),
      edge('branch', 'yes', 'true'),
      edge('branch', 'no', 'false'),
      edge('yes', 'merge'),
      edge('no', 'merge'),
      edge('merge', 'out')
    ]
  );

test('a node whose id has a hyphen is reachable through nodes', async () => {
  const h = harness(afterHyphenatedNode('contains(get(nodes, "prompt-1757"), "gpt-4")'), {
    inputs: { in: 'anything' }
  });
  await h.run();
  assert.deepEqual(h.started, ['in', 'prompt-1757', 'branch', 'yes', 'merge', 'out']);
});

test('naming that node bare is subtraction, and the run says so', async () => {
  const h = harness(afterHyphenatedNode('prompt-1757 == "x"'), { inputs: { in: 'anything' } });
  await assert.rejects(h.run(), /could not be evaluated.*get\(nodes, "prompt-123"\)/s);
});

test('a condition that decides something other than true or false stops the run', async () => {
  // Before, every arrow out of the branch quietly died and the run "finished"
  // with its output node skipped.
  const h = harness(forked('if(length(input) > 500, "long", "short")'), { inputs: { in: 'short' } });
  await assert.rejects(h.run(), /decided "short" rather than true or false/);
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

// ------------------------------------------------- nodes that run at once

// in → a, b, c → merge
const fan = () =>
  workflow(
    'fan3',
    [
      node('in', 'input'),
      prompt('a', 'A:{{input}}'),
      prompt('b', 'B:{{input}}'),
      prompt('c', 'C:{{input}}'),
      node('merge', 'aggregate', { strategy: 'concat', separator: '+' })
    ],
    [edge('in', 'a'), edge('in', 'b'), edge('in', 'c'), edge('a', 'merge'), edge('b', 'merge'), edge('c', 'merge')]
  );

test('nodes that do not depend on each other run at the same time', async () => {
  const h = harness(fan(), { inputs: { in: 'x' } });
  h.llm.hold = true;
  const run = h.run();

  await until(() => ['a', 'b', 'c'].every((id) => h.started.includes(id)), 'all three started');
  assert.ok(!h.completed.some((c) => ['a', 'b', 'c'].includes(c.nodeId)), 'none has finished yet');
  assert.ok(!h.started.includes('merge'), 'the join waits');

  h.llm.release();
  const ctx = await run;
  assert.equal(ctx.merge.output, '<gpt-4: A:x>+<gpt-4: B:x>+<gpt-4: C:x>');
});

test('a join waits for its slowest arrow, and reads them in arrow order whatever order they finished in', async () => {
  const h = harness(fan(), { inputs: { in: 'x' } });
  h.llm.hold = true;
  const run = h.run();
  await until(() => h.started.includes('c'), 'the fan is out');

  // c first, then b, then a: the reverse of arrow order.
  h.llm.release((p) => p.startsWith('C:'));
  await until(() => h.completed.some((c) => c.nodeId === 'c'), 'c finished');
  assert.ok(!h.started.includes('merge'));
  h.llm.release((p) => p.startsWith('B:'));
  await until(() => h.completed.some((c) => c.nodeId === 'b'), 'b finished');
  assert.ok(!h.started.includes('merge'));
  h.llm.release();

  const ctx = await run;
  assert.deepEqual(h.completed.map((c) => c.nodeId).slice(1, 4), ['c', 'b', 'a']);
  assert.equal(ctx.merge.output, '<gpt-4: A:x>+<gpt-4: B:x>+<gpt-4: C:x>', 'arrow order, not finishing order');
});

test('when a node fails, nothing new starts; what is running finishes and is recorded; then the run throws', async () => {
  const h = harness(fan(), { inputs: { in: 'x' } });
  h.llm.failOn = 'A:';
  h.llm.hold = true;
  const run = h.run();
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });
  await until(() => h.started.includes('c'), 'the fan is out');

  h.llm.release((p) => p.startsWith('A:'));
  await until(() => h.completed.some((c) => c.nodeId === 'a' && c.status === 'error'), 'a failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the run waits for b and c');

  h.llm.release();
  await assert.rejects(run, /Node "a" \(a\) failed: model refused: A:/);
  for (const id of ['b', 'c']) {
    assert.ok(h.completed.some((c) => c.nodeId === id && c.status === 'success'), `${id} finished and was recorded`);
  }
  assert.ok(!h.started.includes('merge'), 'nothing new started');
});

test('a failing node releases a gate that was waiting, so a failed run never hangs on a reviewer', async () => {
  // in → a (fails), in → gate (waiting) → merge
  const wf = workflow(
    'fail-beside-gate',
    [node('in', 'input'), prompt('a', 'A:{{input}}'), node('gate', 'human_gate', {}), node('merge', 'aggregate', { strategy: 'concat' })],
    [edge('in', 'a'), edge('in', 'gate'), edge('a', 'merge'), edge('gate', 'merge', 'pass')]
  );
  const h = harness(wf, { inputs: { in: 'x' } }, () => undefined);
  h.llm.failOn = 'A:';
  h.llm.hold = true;
  const run = h.run();
  await until(() => h.paused.length === 1, 'the gate is waiting');
  h.llm.release();

  await assert.rejects(run, /Node "a" \(a\) failed: model refused: A:/);
  assert.deepEqual(h.gates.pending(), [], 'the gate was released');
  assert.match(h.db.getExecutionTraces('run').find((t) => t.nodeId === 'gate')?.error ?? '', /Run failed/);
});

test('two gates on separate branches wait at the same time', async () => {
  // in → a → gateA → merge ← gateB ← b ← in
  const wf = workflow(
    'two-gates',
    [
      node('in', 'input'),
      prompt('a', 'A:{{input}}'),
      prompt('b', 'B:{{input}}'),
      node('gateA', 'human_gate', {}),
      node('gateB', 'human_gate', {}),
      node('merge', 'aggregate', { strategy: 'concat', separator: '+' })
    ],
    [edge('in', 'a'), edge('in', 'b'), edge('a', 'gateA'), edge('b', 'gateB'), edge('gateA', 'merge', 'pass'), edge('gateB', 'merge', 'pass')]
  );
  const h = harness(wf, { inputs: { in: 'x' } }, () => undefined);
  const run = h.run();
  await until(() => h.paused.length === 2, 'both gates are waiting');
  assert.deepEqual(h.gates.pending().map((g) => g.nodeId).sort(), ['gateA', 'gateB']);

  h.gates.resolve('run', 'gateB', { verdict: 'pass' });
  h.gates.resolve('run', 'gateA', { verdict: 'pass' });
  const ctx = await run;
  assert.equal(ctx.merge.output, '<gpt-4: A:x>+<gpt-4: B:x>');
});

// in → draft → side → out
//        ↑  └→ gate ─pass─→ out
//        └──────┘ fail
const sideLoop = () =>
  workflow(
    'side-loop',
    [
      node('in', 'input'),
      prompt('draft', 'D:{{input}}'),
      prompt('side', 'S:{{input}}|{{nodes.gate.decision.note}}'),
      node('gate', 'human_gate', {}),
      node('out', 'output')
    ],
    [
      edge('in', 'draft'),
      edge('draft', 'side'),
      edge('draft', 'gate'),
      edge('gate', 'out', 'pass'),
      edge('gate', 'draft', 'fail'),
      edge('side', 'out')
    ]
  );

test('work sent back while a sibling is still running: the stale run is recorded but decides nothing, even finishing last', async () => {
  const decisions: GateDecision[] = [{ verdict: 'fail', note: 'again' }, { verdict: 'pass' }];
  const h = harness(sideLoop(), { inputs: { in: 'x' } }, (_e, i) => decisions[i]);
  h.llm.hold = true;
  const run = h.run();

  await until(() => h.started.includes('draft'), 'draft started');
  h.llm.release((p) => p === 'D:x');
  // side is still running when the gate sends the work back, and draft goes again.
  await until(() => h.started.filter((id) => id === 'draft').length === 2, 'draft re-runs');
  assert.deepEqual(h.paused.map((e) => e.nodeId), ['gate']);
  h.llm.release((p) => p === 'D:x');
  await until(() => h.started.filter((id) => id === 'side').length === 2, 'side re-runs');
  await until(() => h.paused.length === 2, 'the gate asks again');

  // The fresh side finishes first and the stale one last — the order that
  // would overwrite fresh with stale, were the stale run allowed to decide.
  h.llm.release((p) => p.endsWith('|again'));
  await until(() => h.completed.filter((c) => c.nodeId === 'side').length === 1, 'the fresh side finished');
  h.llm.release();

  const ctx = await run;
  assert.equal(ctx.side.output, '<gpt-4: S:<gpt-4: D:x>|again>', 'the fresh run is what stands');
  assert.deepEqual(ctx.out.output, ['<gpt-4: D:x>', '<gpt-4: S:<gpt-4: D:x>|again>']);
  // Both runs of side are in the record: the stale one happened, and cost.
  const sides = h.db.getExecutionTraces('run').filter((t) => t.nodeId === 'side');
  assert.deepEqual(sides.map((t) => t.status), ['success', 'success']);
});

test('a gate still waiting when the work is sent back is released, and asks again with the redone content', async () => {
  // in → draft → gateA ─pass─→ out
  //        ↑  └→ gateB ─pass─→ out
  //        └──────┘ fail
  const wf = workflow(
    'two-gates-loop',
    [
      node('in', 'input'),
      prompt('draft', 'D:{{input}}|{{nodes.gateB.decision.note}}'),
      node('gateA', 'human_gate', {}),
      node('gateB', 'human_gate', {}),
      node('out', 'output')
    ],
    [
      edge('in', 'draft'),
      edge('draft', 'gateA'),
      edge('draft', 'gateB'),
      edge('gateA', 'out', 'pass'),
      edge('gateB', 'out', 'pass'),
      edge('gateB', 'draft', 'fail')
    ]
  );
  // gateA is left waiting; gateB sends the work back; then both approve.
  const decide: Decide = (_event, index) =>
    index === 0 ? undefined : index === 1 ? { verdict: 'fail', note: 'redo' } : { verdict: 'pass' };
  const h = harness(wf, { inputs: { in: 'x' } }, decide);
  const ctx = await h.run();

  assert.deepEqual(h.paused.map((e) => e.nodeId), ['gateA', 'gateB', 'gateA', 'gateB']);
  assert.deepEqual(h.paused.map((e) => e.revision), [0, 0, 0, 1]);
  assert.deepEqual(h.llm.calls.map((c) => c.userPrompt), ['D:x|', 'D:x|redo']);
  // The first gateA was released rather than left waiting on stale content,
  // and that is in the record; the run itself did not fail over it.
  const gateA = h.db.getExecutionTraces('run').filter((t) => t.nodeId === 'gateA');
  assert.deepEqual(gateA.map((t) => t.status), ['error', 'success']);
  assert.match(gateA[0].error ?? '', /Superseded/);
  assert.equal(ctx.gateA.decision?.verdict, 'pass');
  assert.equal(ctx.gateB.decision?.verdict, 'pass');
  assert.deepEqual(ctx.out.output, ['<gpt-4: D:x|redo>', '<gpt-4: D:x|redo>']);
  assert.deepEqual(h.gates.pending(), []);
});

test('the example workflow runs to the end and Final Output is what the editor approved', async () => {
  const wf = createExampleWorkflow();
  const h = harness(wf, { inputs: { example_input: 'An article about rivers.' } }, pass);
  const ctx = await h.run();

  // Draft really receives the article now, and no note on the first pass.
  assert.equal(h.llm.calls[0].userPrompt, 'An article about rivers.');
  assert.ok(!h.llm.calls[0].systemPrompt.includes('sent your previous draft back'));
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

test('sending the example back re-drafts with the note, and the second approval reaches Final Output', async () => {
  const decisions: GateDecision[] = [{ verdict: 'fail', note: 'one paragraph, please' }, { verdict: 'pass' }];
  const h = harness(createExampleWorkflow(), { inputs: { example_input: 'An article about rivers.' } }, (_e, i) => decisions[i]);
  const ctx = await h.run();

  const draftCalls = h.llm.calls.filter((c) => c.systemPrompt.startsWith('You are a skilled editor'));
  assert.equal(draftCalls.length, 2, 'Draft Summary ran twice');
  assert.ok(!draftCalls[0].systemPrompt.includes('one paragraph, please'));
  assert.ok(draftCalls[1].systemPrompt.includes('sent your previous draft back with this note: "one paragraph, please"'));
  assert.equal(draftCalls[1].userPrompt, 'An article about rivers.', 'the article itself is unchanged');
  // Everything after Draft ran again; the input did not.
  assert.equal(h.started.filter((id) => id === 'example_input').length, 1);
  assert.equal(h.started.filter((id) => id === 'example_revision').length, 2);
  assert.equal(h.paused.length, 2);
  assert.equal(h.paused[1].revision, 1);
  assert.equal(ctx.example_output.output, ctx.example_merge.output);
  assert.equal(h.completed.at(-1)?.nodeId, 'example_output');
});

test('best of four sends one prompt to four models and hands all four to the judge', async () => {
  const question = 'Why is the sky blue?';
  const wf = createBestOfFour();
  const h = harness(wf, { inputs: { bestof_input: question } });
  const ctx = await h.run();

  // Four answers and a verdict: one call per candidate, then the judge.
  assert.equal(h.llm.calls.length, 5);
  const candidates = wf.nodes.filter((n) => n.type === 'prompt' && n.id !== 'bestof_judge');
  const judge = wf.nodes.find((n) => n.id === 'bestof_judge')!;

  // Each candidate ran on its own model, and each was given the question itself.
  const field = h.llm.calls.slice(0, 4);
  assert.deepEqual(
    field.map((c) => c.model),
    candidates.map((n) => (n.data.config as any).model)
  );
  for (const call of field) {
    assert.equal(call.userPrompt, question);
    assert.equal(call.systemPrompt, (candidates[0].data.config as any).systemPrompt);
  }

  // The judge got the question and all four answers — nothing lost to {{input}}
  // picking whichever arrow arrived first.
  const verdict = h.llm.calls[4];
  assert.equal(verdict.model, (judge.data.config as any).model);
  assert.ok(verdict.userPrompt.includes(question));
  for (const candidate of candidates) {
    assert.ok(
      verdict.userPrompt.includes(String(ctx[candidate.id].output)),
      `the judge should have been given ${candidate.id}'s answer`
    );
  }
  for (const letter of ['A', 'B', 'C', 'D']) {
    assert.ok(verdict.userPrompt.includes(`--- Answer ${letter} ---`));
  }

  // What the workflow produces is the judge's pick.
  assert.equal(ctx.bestof_output.output, ctx.bestof_judge.output);
  assert.equal(h.completed.at(-1)?.nodeId, 'bestof_output');
});

// ==================== what a run records about its decisions ====================
//
// These read the traces back out of SQLite rather than off the events, so they
// cover the write and the read as well as what the executor decided to record.

test('a branch records the condition it decided on and the arrow it fired', async () => {
  const h = harness(forked('length(input) > 500'), { inputs: { in: 'x'.repeat(640) } });
  await h.run();

  const traces = h.db.getExecutionTraces('run');
  assert.deepEqual(traces.find((t) => t.nodeId === 'branch')?.detail, {
    condition: 'length(input) > 500',
    handle: 'true'
  });
});

test('a node that never ran records which node went the other way', async () => {
  const h = harness(forked('input == "go"'), { inputs: { in: 'stop' } });
  await h.run();

  const skipped = h.db.getExecutionTraces('run').find((t) => t.nodeId === 'yes');
  assert.equal(skipped?.status, 'skipped');
  assert.deepEqual(skipped?.detail, { skippedBy: ['branch'] });
});

test('a branch with no condition set records the true it defaulted to', async () => {
  const wf = forked('');
  const h = harness(wf, { inputs: { in: 'anything' } });
  await h.run();

  assert.deepEqual(h.db.getExecutionTraces('run').find((t) => t.nodeId === 'branch')?.detail, {
    condition: 'true',
    handle: 'true'
  });
});

test('a gate records the handle the reviewer sent it down', async () => {
  const h = harness(gated(), {}, pass);
  await h.run();

  const gate = h.db.getExecutionTraces('run').find((t) => t.nodeId === 'gate');
  assert.deepEqual(gate?.detail, { handle: 'pass' });
  // The decision itself has been recorded as the gate's input since before
  // traces carried a detail, and still is.
  assert.equal(gate?.input.decision.verdict, 'pass');
});

test('the model a node ran on survives the write', async () => {
  const h = harness(linear(), { inputs: { in: 'the article' } });
  await h.run();

  assert.equal(h.db.getExecutionTraces('run').find((t) => t.nodeId === 'draft')?.model, 'gpt-4');
});

test('a node with nothing to decide records no detail at all', async () => {
  const h = harness(linear(), { inputs: { in: 'the article' } });
  await h.run();

  assert.equal(h.db.getExecutionTraces('run').find((t) => t.nodeId === 'draft')?.detail, undefined);
});
