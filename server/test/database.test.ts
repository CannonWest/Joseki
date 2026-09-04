import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage, Conversation } from '@maestroai/shared';
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
    tokenUsage: { prompt: 3, completion: 2, total: 5, cachedTokens: 1 },
    cost: 0.0001,
    latencyMs: 250,
    finishReason: 'stop',
    reasoning: 'because',
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

test('opening an existing database replaces the vestigial conversation_trees table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestroai-db-'));
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
  assert.ok(tables.includes('conversations'));
  assert.ok(tables.includes('messages'));
  assert.ok(tables.includes('workflows'));
});
