import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionDetail } from '@joseki/shared';
import { runCost, runDuration, runShape, runWhen, statusTone } from '../src/runs/format';
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
