import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage, Conversation } from '@joseki/shared';
import { Database } from '../src/db/database';

function conversation(id: string, stamp = 1000): Conversation {
  return {
    id,
    title: 'Test',
    model: 'openai/gpt-4o-mini',
    systemPrompt: null,
    params: { temperature: 0.5 },
    activeLeafId: null,
    createdAt: stamp,
    updatedAt: stamp
  };
}

function message(
  id: string,
  conversationId: string,
  parentId: string | null,
  role: ChatMessage['role'],
  content: string,
  createdAt: number
): ChatMessage {
  return { id, conversationId, parentId, role, content, createdAt };
}

test('conversations round-trip and list most recently updated first', () => {
  const db = new Database(':memory:');
  const older = conversation('old', 1000);
  const newer = conversation('new', 2000);
  db.createConversation(older);
  db.createConversation(newer);

  assert.deepEqual(db.getConversation('old'), older);
  assert.deepEqual(db.getAllConversations().map((c) => c.id), ['new', 'old']);

  const updated = db.updateConversation('old', {
    title: 'Renamed',
    systemPrompt: 'Be terse',
    params: { temperature: 0.1, maxTokens: 10 }
  });
  assert.equal(updated?.title, 'Renamed');
  assert.equal(updated?.systemPrompt, 'Be terse');
  assert.deepEqual(updated?.params, { temperature: 0.1, maxTokens: 10 });
  assert.equal(updated?.model, older.model);
  assert.ok(updated!.updatedAt > newer.updatedAt);
  assert.deepEqual(db.getAllConversations().map((c) => c.id), ['old', 'new']);

  assert.equal(db.updateConversation('old', { systemPrompt: null })?.systemPrompt, null);
  assert.equal(db.updateConversation('missing', { title: 'x' }), undefined);

  db.deleteConversation('old');
  assert.equal(db.getConversation('old'), undefined);
  assert.deepEqual(db.getAllConversations().map((c) => c.id), ['new']);
  db.close();
});

test('messages form a tree; the active path walks from the active leaf to the root', () => {
  const db = new Database(':memory:');
  db.createConversation(conversation('c1'));
  db.createMessage(message('u1', 'c1', null, 'user', 'first', 1));
  db.createMessage(message('a1', 'c1', 'u1', 'assistant', 'reply one', 2));
  db.createMessage(message('a1b', 'c1', 'u1', 'assistant', 'reply one, retried', 3));
  db.createMessage(message('u2', 'c1', 'a1', 'user', 'second', 4));
  db.createMessage(message('a2', 'c1', 'u2', 'assistant', 'reply two', 5));

  assert.deepEqual(db.getMessages('c1').map((m) => m.id), ['u1', 'a1', 'a1b', 'u2', 'a2']);
  assert.deepEqual(db.getActivePath('c1'), []);

  db.updateConversation('c1', { activeLeafId: 'a2' });
  assert.deepEqual(db.getActivePath('c1').map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);

  db.updateConversation('c1', { activeLeafId: 'a1b' });
  assert.deepEqual(db.getActivePath('c1').map((m) => m.id), ['u1', 'a1b']);

  db.updateConversation('c1', { activeLeafId: null });
  assert.deepEqual(db.getActivePath('c1'), []);
  db.close();
});

test('message metadata survives the round-trip and unset fields stay absent', () => {
  const db = new Database(':memory:');
  db.createConversation(conversation('c1'));

  const full: ChatMessage = {
    ...message('a1', 'c1', null, 'assistant', 'hi', 1),
    model: 'openai/gpt-4o-mini',
    provider: 'Azure',
    tokenUsage: { prompt: 3, completion: 2, total: 5, cachedTokens: 1 },
    cost: 0.0001,
    latencyMs: 250,
    finishReason: 'stop',
    reasoning: 'because',
    reasoningDetails: [{ type: 'reasoning.text', text: 'because', index: 0 }],
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }]
  };
  db.createMessage(full);
  assert.deepEqual(db.getMessage('a1'), full);

  const bare = message('u1', 'c1', null, 'user', 'hello', 2);
  db.createMessage(bare);
  assert.deepEqual(db.getMessage('u1'), bare);

  const tool: ChatMessage = { ...message('t1', 'c1', 'a1', 'tool', 'result', 3), toolCallId: 'call_1' };
  db.createMessage(tool);
  assert.deepEqual(db.getMessage('t1'), tool);

  const failed: ChatMessage = { ...message('a2', 'c1', 'u1', 'assistant', '', 4), error: 'boom' };
  db.createMessage(failed);
  assert.deepEqual(db.getMessage('a2'), failed);

  assert.equal(db.getMessage('missing'), undefined);
  db.close();
});

test('deleting a conversation removes its messages and leaves others alone', () => {
  const db = new Database(':memory:');
  db.createConversation(conversation('c1'));
  db.createConversation(conversation('c2'));
  db.createMessage(message('u1', 'c1', null, 'user', 'one', 1));
  db.createMessage(message('a1', 'c1', 'u1', 'assistant', 'two', 2));
  db.createMessage(message('u2', 'c2', null, 'user', 'other', 3));

  db.deleteConversation('c1');
  assert.deepEqual(db.getMessages('c1'), []);
  assert.equal(db.getMessage('u1'), undefined);
  assert.deepEqual(db.getMessages('c2').map((m) => m.id), ['u2']);
  db.close();
});

test('deleting a workflow that has run removes its executions and traces too', () => {
  const db = new Database(':memory:');
  const [workflow] = db.getAllWorkflows();
  db.createExecution({ id: 'run-1', workflowId: workflow.id, status: 'running', context: {}, startedAt: 1 });
  db.createExecutionTrace({
    executionId: 'run-1',
    nodeId: workflow.nodes[0].id,
    runId: 'run-1',
    timestamp: 1,
    input: null,
    output: 'x',
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    cost: 0,
    latencyMs: 1,
    status: 'success'
  });

  // Foreign keys are enforced: without the cascade this throws.
  db.deleteWorkflow(workflow.id);

  assert.equal(db.getWorkflow(workflow.id), undefined);
  const raw = (db as unknown as { db: BetterSqlite3.Database }).db;
  assert.deepEqual(raw.prepare('SELECT COUNT(*) AS n FROM executions').get(), { n: 0 });
  assert.deepEqual(raw.prepare('SELECT COUNT(*) AS n FROM execution_traces').get(), { n: 0 });
  db.close();
});

test('opening an existing database replaces the vestigial conversation_trees table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joseki-db-'));
  const file = path.join(dir, 'legacy.db');
  const legacy = new BetterSqlite3(file);
  legacy.exec(`CREATE TABLE conversation_trees (id TEXT PRIMARY KEY, nodes TEXT NOT NULL)`);
  legacy.close();

  const db = new Database(file);
  db.close();

  const inspect = new BetterSqlite3(file, { readonly: true });
  const tables = inspect
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name);
  inspect.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(tables.includes('conversation_trees'), false);
  assert.equal(tables.includes('model_configs'), false, 'retired in v5, and never made since');
  assert.ok(tables.includes('conversations'));
  assert.ok(tables.includes('messages'));
  assert.ok(tables.includes('workflows'));
});

test('opening a database from before reasoning_details adds the column and keeps the rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joseki-db-'));
  const file = path.join(dir, 'older.db');
  const older = new BetterSqlite3(file);
  older.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT,
      params TEXT NOT NULL, active_leaf_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, model TEXT, token_usage TEXT, cost REAL, latency_ms INTEGER,
      finish_reason TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, error TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO conversations VALUES ('c1', 'Old', 'm', NULL, '{}', 'u1', 1, 1);
    INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES ('u1', 'c1', NULL, 'user', 'hello', 1);
  `);
  older.close();

  const db = new Database(file);
  assert.deepEqual(db.getMessage('u1'), { id: 'u1', conversationId: 'c1', parentId: null, role: 'user', content: 'hello', createdAt: 1 });
  db.createMessage({
    ...message('a1', 'c1', 'u1', 'assistant', 'hi', 2),
    reasoningDetails: [{ type: 'reasoning.text', text: 't', index: 0 }]
  });
  assert.deepEqual(db.getMessage('a1')?.reasoningDetails, [{ type: 'reasoning.text', text: 't', index: 0 }]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== Run history ====================

function trace(
  executionId: string,
  nodeId: string,
  timestamp: number,
  overrides: Partial<Parameters<Database['createExecutionTrace']>[0]> = {}
) {
  return {
    executionId,
    nodeId,
    runId: executionId,
    timestamp,
    input: null,
    output: `${nodeId} output`,
    tokenUsage: { prompt: 10, completion: 5, total: 15 },
    cost: 0.001,
    latencyMs: 100,
    status: 'success' as const,
    ...overrides
  };
}

function historyFixture() {
  const db = new Database(':memory:');
  const [workflow] = db.getAllWorkflows();

  db.createExecution({ id: 'run-old', workflowId: workflow.id, status: 'error', context: {}, startedAt: 1000 });
  db.updateExecutionStatus('run-old', 'error', 'it broke', 1500);
  db.createExecutionTrace(trace('run-old', 'a', 1100, { status: 'error', error: 'it broke', cost: 0 }));

  db.createExecution({
    id: 'run-new',
    workflowId: workflow.id,
    status: 'running',
    context: { topic: 'bees' },
    startedAt: 2000
  });
  db.updateExecutionStatus('run-new', 'success', undefined, 2900);
  // Node "a" ran twice — a gate sent it back — and "b" was never reached.
  db.createExecutionTrace(trace('run-new', 'a', 2100));
  db.createExecutionTrace(trace('run-new', 'gate', 2200));
  db.createExecutionTrace(trace('run-new', 'a', 2300, { output: 'a redraft' }));
  db.createExecutionTrace(trace('run-new', 'b', 2400, { status: 'skipped', cost: 0, tokenUsage: { prompt: 0, completion: 0, total: 0 } }));

  return { db, workflowId: workflow.id, workflowName: workflow.name };
}

test('a past run reads back with its status, error and context', () => {
  const { db } = historyFixture();

  const failed = db.getExecution('run-old');
  assert.equal(failed?.status, 'error');
  assert.equal(failed?.error, 'it broke');
  assert.equal(failed?.completedAt, 1500);

  const finished = db.getExecution('run-new');
  assert.deepEqual(finished?.context, { topic: 'bees' });
  assert.equal(finished?.parentExecutionId, undefined);

  assert.equal(db.getExecution('no-such-run'), undefined);
  db.close();
});

test('the runs list is most recent first and rolls up the traces', () => {
  const { db, workflowName } = historyFixture();
  const runs = db.listExecutions();

  assert.deepEqual(runs.map((r) => r.id), ['run-new', 'run-old']);
  assert.equal(runs[0].workflowName, workflowName);

  // Four traces over three distinct nodes: "a" ran twice.
  assert.equal(runs[0].traceCount, 4);
  assert.equal(runs[0].nodeCount, 3);
  assert.equal(runs[0].totalCost, 0.003);
  assert.equal(runs[0].totalTokens, 45);
  db.close();
});

test('the runs list narrows by workflow and caps at the limit', () => {
  const { db, workflowId } = historyFixture();

  assert.equal(db.listExecutions({ workflowId }).length, 2);
  assert.deepEqual(db.listExecutions({ workflowId: 'some-other-workflow' }), []);
  assert.deepEqual(db.listExecutions({ limit: 1 }).map((r) => r.id), ['run-new']);
  db.close();
});

test('a run that wrote no traces still lists, with zeroes', () => {
  const { db, workflowId } = historyFixture();
  db.createExecution({ id: 'run-empty', workflowId, status: 'running', context: {}, startedAt: 3000 });

  const [newest] = db.listExecutions({ limit: 1 });
  assert.equal(newest.id, 'run-empty');
  assert.equal(newest.traceCount, 0);
  assert.equal(newest.nodeCount, 0);
  assert.equal(newest.totalCost, 0);
  assert.equal(newest.totalTokens, 0);
  db.close();
});

test('a single run reads back with the same rollups the list shows', () => {
  const { db } = historyFixture();

  assert.deepEqual(db.getExecutionSummary('run-new'), db.listExecutions({ limit: 1 })[0]);
  assert.equal(db.getExecutionSummary('no-such-run'), undefined);
  db.close();
});

test('traces come back in the order they happened, a reworked node once per attempt', () => {
  const { db } = historyFixture();
  const traces = db.getExecutionTraces('run-new');

  assert.deepEqual(traces.map((t) => t.nodeId), ['a', 'gate', 'a', 'b']);
  assert.deepEqual(traces.map((t) => t.output), ['a output', 'gate output', 'a redraft', 'b output']);
  assert.equal(traces[3].status, 'skipped');
  assert.equal(traces[0].runId, 'run-new');
  assert.deepEqual(traces[0].tokenUsage, { prompt: 10, completion: 5, total: 15 });

  assert.deepEqual(db.getExecutionTraces('no-such-run'), []);
  db.close();
});

test('traces sharing a millisecond keep their insertion order', () => {
  const { db, workflowId } = historyFixture();
  db.createExecution({ id: 'run-tie', workflowId, status: 'success', context: {}, startedAt: 4000 });
  db.createExecutionTrace(trace('run-tie', 'first', 4100));
  db.createExecutionTrace(trace('run-tie', 'second', 4100));
  db.createExecutionTrace(trace('run-tie', 'third', 4100));

  assert.deepEqual(
    db.getExecutionTraces('run-tie').map((t) => t.nodeId),
    ['first', 'second', 'third']
  );
  db.close();
});
