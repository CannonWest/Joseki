import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionDetail } from '@joseki/shared';
import { labelsOf, runCost, runDuration, runShape, runWhen, statusTone, traceLine, traceTone } from '../src/runs/format';
import { logsFromRun, nodeStatesFromTraces } from '../src/stores/executionStore';

function trace(nodeId: string, timestamp: number, overrides: Partial<ExecutionDetail['traces'][number]> = {}) {
  return {
    nodeId,
    runId: 'run-1',
    timestamp,
    input: null,
    output: `${nodeId} output`,
    tokenUsage: { prompt: 1, completion: 1, total: 2 },
    cost: 0.001,
    latencyMs: 1500,
    status: 'success' as const,
    ...overrides
  };
}

function detail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    workflowName: 'Content Review Pipeline',
    status: 'success',
    context: {},
    startedAt: 1_000_000,
    completedAt: 1_040_000,
    traceCount: 3,
    nodeCount: 2,
    totalCost: 0.003,
    totalTokens: 6,
    traces: [trace('draft', 1_001_000), trace('gate', 1_002_000), trace('draft', 1_003_000, { output: 'redraft' })],
    ...overrides
  };
}

test('a run reopened puts each node in the state it ended in, the last attempt winning', () => {
  const states = nodeStatesFromTraces(detail().traces);

  assert.deepEqual([...states.keys()], ['draft', 'gate']);
  assert.equal(states.get('draft')?.trace?.output, 'redraft');
  assert.equal(states.get('draft')?.status, 'success');
  // Nothing is mid-stream in a finished run.
  assert.equal(states.get('draft')?.streamingContent, '');
});

test('a failed node keeps its error when the run is reopened', () => {
  const states = nodeStatesFromTraces([
    trace('input', 10, { status: 'error', error: 'Input "Article Text" is required', output: null })
  ]);

  assert.equal(states.get('input')?.status, 'error');
  assert.equal(states.get('input')?.trace?.error, 'Input "Article Text" is required');
});

test('a skipped node reads as skipped, not as never having run', () => {
  const states = nodeStatesFromTraces([trace('unused', 10, { status: 'skipped' })]);
  assert.equal(states.get('unused')?.status, 'skipped');
});

test('the log of a reopened run names the run, every attempt, and the outcome', () => {
  const logs = logsFromRun(detail());

  assert.match(logs[0].message, /^Run of /);
  assert.deepEqual(
    logs.slice(1, 4).map((l) => l.message),
    ['draft — success · 1.5s', 'gate — success · 1.5s', 'draft — success · 1.5s']
  );
  assert.equal(logs.at(-1)?.message, 'Run success');
  assert.equal(logs.at(-1)?.type, 'success');
});

test('a failed run says what failed, in the log and at the end', () => {
  const logs = logsFromRun(
    detail({
      status: 'error',
      error: 'Node "Article Text" failed',
      traces: [trace('input', 10, { status: 'error', error: 'no value was supplied', latencyMs: 0 })]
    })
  );

  assert.equal(logs[1].message, 'input failed: no value was supplied');
  assert.equal(logs[1].type, 'error');
  assert.equal(logs.at(-1)?.message, 'Run failed: Node "Article Text" failed');
  assert.equal(logs.at(-1)?.type, 'error');
});

test('a run duration reads in the unit that suits it, and an unfinished run has none', () => {
  assert.equal(runDuration({ startedAt: 0, completedAt: 400 }), '400ms');
  assert.equal(runDuration({ startedAt: 0, completedAt: 38_100 }), '38.1s');
  assert.equal(runDuration({ startedAt: 0, completedAt: 95_000 }), '1m 35s');
  assert.equal(runDuration({ startedAt: 0, completedAt: undefined }), '—');
});

test('a cost too small for cents keeps its digits, and a free run says so', () => {
  assert.equal(runCost(0), 'free');
  assert.equal(runCost(0.0016032), '$0.0016');
  assert.equal(runCost(1.5), '$1.50');
});

test('a run that reworked a node says how many attempts it took', () => {
  assert.equal(runShape(detail()), '2 nodes, 3 attempts · 6 tok · $0.0030');
  assert.equal(
    runShape(detail({ traceCount: 1, nodeCount: 1, totalTokens: 0, totalCost: 0 })),
    '1 node · free'
  );
});

test('a node that ended on its fallback says so, rather than reading as a clean success', () => {
  const recovered = trace('draft', 10, { error: 'model refused: boom' });

  assert.equal(traceLine('draft', recovered), 'draft carried on with its fallback after: model refused: boom');
  assert.equal(traceTone(recovered), 'info', 'a recovery is not a clean success');

  // The same node without the wobble reads the way it always did.
  assert.equal(traceLine('draft', trace('draft', 10)), 'draft — success · 1.5s');
  assert.equal(traceTone(trace('draft', 10)), 'success');
});

test('a failed attempt names its reason, and a skipped node says why it never ran', () => {
  const failed = trace('draft', 10, { status: 'error', error: 'model refused: boom' });
  assert.equal(traceLine('draft', failed), 'draft failed: model refused: boom');
  assert.equal(traceTone(failed), 'error');

  const silent = trace('draft', 10, { status: 'error', error: undefined });
  assert.equal(traceLine('draft', silent), 'draft failed: no reason given');

  const skipped = trace('unused', 10, { status: 'skipped' });
  assert.equal(traceLine('unused', skipped), 'unused skipped: its path was not taken');
  assert.equal(traceTone(skipped), 'info');
});

test('a retried node reads as its failures followed by the try that worked', () => {
  const logs = logsFromRun(
    detail({
      traces: [
        trace('draft', 10, { status: 'error', error: 'model refused: boom', latencyMs: 0 }),
        trace('draft', 20)
      ]
    })
  );

  assert.deepEqual(
    logs.slice(1, 3).map((l) => [l.message, l.type]),
    [
      ['draft failed: model refused: boom', 'error'],
      ['draft — success · 1.5s', 'success']
    ]
  );
});

test('a run from today shows the clock, an older one shows the date', () => {
  const now = new Date('2026-09-12T18:00:00');
  const today = new Date('2026-09-12T07:27:00').getTime();
  const before = new Date('2026-09-09T07:27:00').getTime();

  assert.doesNotMatch(runWhen(today, now), /Sep/);
  assert.match(runWhen(before, now), /Sep/);
});

test('each outcome gets its own tone, and an unknown one falls back', () => {
  assert.notEqual(statusTone('success'), statusTone('error'));
  assert.notEqual(statusTone('paused'), statusTone('running'));
  assert.equal(statusTone('pending'), statusTone('skipped'));
});

// ==================== what a node decided ====================

test('a branch says which arrow fired and on what condition', () => {
  const branch = trace('example_quality_check', 10, {
    output: 'true',
    latencyMs: 0,
    detail: { condition: 'length(input) > 500', handle: 'true' }
  });
  assert.equal(
    traceLine('example_quality_check', branch),
    'example_quality_check → true · length(input) > 500'
  );
});

test('the condition it reports is the run\'s own, not the one on the canvas now', () => {
  // Recorded with the trace for exactly this reason: editing the branch
  // afterwards must not rewrite what an old run says it decided.
  const branch = trace('b', 10, { latencyMs: 0, detail: { condition: '1 == 0', handle: 'false' } });
  assert.match(traceLine('b', branch), /1 == 0/);
});

test('a branch with no condition recorded still says which way it went', () => {
  const branch = trace('b', 10, { latencyMs: 0, detail: { handle: 'false' } });
  assert.equal(traceLine('b', branch), 'b → false');
});

test('a skipped node names what went the other way', () => {
  const skipped = trace('revision', 10, {
    status: 'skipped',
    detail: { skippedBy: ['example_quality_check'] }
  });
  assert.equal(
    traceLine('revision', skipped),
    'revision skipped — example_quality_check went the other way'
  );
});

test('several nodes that skipped a path read as a list', () => {
  const skipped = trace('join', 10, { status: 'skipped', detail: { skippedBy: ['a', 'b', 'c'] } });
  assert.equal(traceLine('join', skipped), 'join skipped — a, b and c went the other way');
});

test('a run recorded before detail existed still reads', () => {
  const skipped = trace('unused', 10, { status: 'skipped' });
  assert.equal(traceLine('unused', skipped), 'unused skipped: its path was not taken');
});

test('a gate says what the reviewer decided, and their note', () => {
  const approved = trace('gate', 10, { input: { decision: { verdict: 'pass' } } });
  assert.equal(traceLine('gate', approved), 'gate approved · 1.5s');

  const edited = trace('gate', 10, {
    input: { decision: { verdict: 'pass', edited: 'a tidier draft', note: 'trimmed the intro' } }
  });
  assert.equal(traceLine('gate', edited), 'gate approved, with edits — "trimmed the intro" · 1.5s');

  const sentBack = trace('gate', 10, {
    input: { decision: { verdict: 'fail', note: 'too long; keep to two paragraphs' } }
  });
  assert.equal(
    traceLine('gate', sentBack),
    'gate sent back — "too long; keep to two paragraphs" · 1.5s'
  );
});

test('a gate that has not been decided yet is not reported as one that has', () => {
  const waiting = trace('gate', 10, { input: { inputs: {}, nodes: {} } });
  assert.equal(traceLine('gate', waiting), 'gate — success · 1.5s');
});

// ==================== names ====================

test('the log reads in labels, and falls back to the id for a node that is gone', () => {
  const labelOf = labelsOf([
    { id: 'example_quality_check', data: { label: 'Quality Check' } },
    { id: 'revision', data: { label: 'Revision' } }
  ]);

  const branch = trace('example_quality_check', 10, {
    latencyMs: 0,
    detail: { condition: 'length(input) > 500', handle: 'true' }
  });
  assert.equal(
    traceLine('example_quality_check', branch, labelOf),
    'Quality Check → true · length(input) > 500'
  );

  const skipped = trace('revision', 10, {
    status: 'skipped',
    detail: { skippedBy: ['example_quality_check'] }
  });
  assert.equal(traceLine('revision', skipped, labelOf), 'Revision skipped — Quality Check went the other way');

  const deleted = trace('gone-1757', 10, { status: 'skipped' });
  assert.match(traceLine('gone-1757', deleted, labelOf), /^gone-1757 skipped/);
});

test('a run reopened is told in labels too', () => {
  const labelOf = labelsOf([{ id: 'draft', data: { label: 'Draft' } }]);
  const logs = logsFromRun(detail(), labelOf);
  assert.ok(logs.some((l) => l.message.startsWith('Draft — success')));
  assert.equal(logs.some((l) => l.message.startsWith('draft —')), false);
});
