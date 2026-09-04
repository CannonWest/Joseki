import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database';
import {
  ChatError,
  ChatService,
  DEFAULT_CHAT_PARAMS,
  DEFAULT_CONVERSATION_TITLE,
  type ChatEvents,
  type ChatProvider
} from '../src/chat/service';
import type { ChatRequest, ChatResult, ChatStreamEvent } from '../src/providers/openrouter';

type Script = (request: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatStreamEvent>;

class FakeProvider implements ChatProvider {
  requests: ChatRequest[] = [];

  constructor(private readonly script: Script) {}

  chatStream(request: ChatRequest, options?: { signal?: AbortSignal }) {
    this.requests.push(request);
    return this.script(request, options?.signal);
  }
}

function reply(tokens: string[], extra: Partial<ChatResult> = {}): Script {
  return async function* (request) {
    for (const token of tokens) yield { type: 'token', text: token };
    yield {
      type: 'done',
      result: {
        content: tokens.join(''),
        model: request.model,
        tokenUsage: { prompt: 5, completion: tokens.length, total: 5 + tokens.length },
        cost: 0.0001,
        finishReason: 'stop',
        ...extra
      }
    };
  };
}

/** A reply that streams one token, then waits to be cancelled. */
function hanging(): Script {
  return async function* (request, signal) {
    yield { type: 'token', text: 'partial' };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield {
      type: 'done',
      result: {
        content: 'partial',
        model: request.model,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'cancelled'
      }
    };
  };
}

function recorder() {
  const log: string[] = [];
  const events: ChatEvents = {
    onUserMessage: (m) => log.push(`user:${m.content}`),
    onStart: (e) => log.push(`start:${e.model}`),
    onToken: (e) => log.push(`token:${e.token}`),
    onReasoning: (e) => log.push(`reasoning:${e.text}`),
    onComplete: (e) => log.push(`complete:${e.message.content}`),
    onError: (e) => log.push(`error:${e.error}`)
  };
  return { log, events };
}

function setup(script: Script) {
  const db = new Database(':memory:');
  const provider = new FakeProvider(script);
  const service = new ChatService(db, provider, { defaultModel: 'test/model' });
  return { db, provider, service };
}

test('createConversation applies defaults and trims what it is given', () => {
  const { service } = setup(reply([]));

  const plain = service.createConversation();
  assert.equal(plain.title, DEFAULT_CONVERSATION_TITLE);
  assert.equal(plain.model, 'test/model');
  assert.equal(plain.systemPrompt, null);
  assert.deepEqual(plain.params, DEFAULT_CHAT_PARAMS);
  assert.equal(plain.activeLeafId, null);

  const custom = service.createConversation({
    title: ' Plans ',
    model: 'x/y',
    systemPrompt: 'Be brief',
    params: { temperature: 0 }
  });
  assert.equal(custom.title, 'Plans');
  assert.equal(custom.model, 'x/y');
  assert.equal(custom.systemPrompt, 'Be brief');
  assert.deepEqual(custom.params, { ...DEFAULT_CHAT_PARAMS, temperature: 0 });
});

test('a turn stores both messages, streams events in order and moves the active leaf', async () => {
  const { db, provider, service } = setup(reply(['Hel', 'lo'], { reasoning: 'thought' }));
  const conversation = service.createConversation({ systemPrompt: 'Be brief' });
  const { log, events } = recorder();

  const assistant = await service.send({ conversationId: conversation.id, content: 'Hi there' }, events);

  assert.deepEqual(log, ['user:Hi there', 'start:test/model', 'token:Hel', 'token:lo', 'complete:Hello']);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, 'Hello');
  assert.equal(assistant.model, 'test/model');
  assert.equal(assistant.cost, 0.0001);
  assert.equal(assistant.finishReason, 'stop');
  assert.equal(assistant.reasoning, 'thought');
  assert.deepEqual(assistant.tokenUsage, { prompt: 5, completion: 2, total: 7 });
  assert.equal(typeof assistant.latencyMs, 'number');
  assert.equal(assistant.error, undefined);

  const stored = db.getMessages(conversation.id);
  assert.deepEqual(
    stored.map((m) => [m.role, m.content, m.parentId]),
    [
      ['user', 'Hi there', null],
      ['assistant', 'Hello', stored[0].id]
    ]
  );
  assert.deepEqual(db.getMessage(assistant.id), assistant);

  const reloaded = db.getConversation(conversation.id)!;
  assert.equal(reloaded.activeLeafId, assistant.id);
  assert.equal(reloaded.title, 'Hi there');

  assert.deepEqual(provider.requests[0].messages, [
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: 'Hi there' }
  ]);
  assert.deepEqual(provider.requests[0].params, DEFAULT_CHAT_PARAMS);
  assert.equal(service.isGenerating(conversation.id), false);
});

test('the second turn sends the whole active path and honours per-turn overrides', async () => {
  const { db, provider, service } = setup(reply(['ok']));
  const conversation = service.createConversation({ title: 'Kept' });

  await service.send({ conversationId: conversation.id, content: 'one' });
  await service.send({
    conversationId: conversation.id,
    content: 'two',
    model: 'other/model',
    params: { temperature: 0 }
  });

  assert.deepEqual(provider.requests[1].messages, [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'two' }
  ]);
  assert.equal(provider.requests[1].model, 'other/model');
  assert.deepEqual(provider.requests[1].params, { ...DEFAULT_CHAT_PARAMS, temperature: 0 });

  const reloaded = db.getConversation(conversation.id)!;
  assert.equal(reloaded.title, 'Kept');
  assert.equal(reloaded.model, 'test/model');
});

test('a long first message becomes a trimmed title', async () => {
  const { db, service } = setup(reply(['ok']));
  const conversation = service.createConversation();
  const content = `${'word '.repeat(20).trim()}\nsecond line`;

  await service.send({ conversationId: conversation.id, content });

  const title = db.getConversation(conversation.id)!.title;
  assert.equal(title.length, 60);
  assert.ok(title.endsWith('…'));
  assert.equal(title.includes('\n'), false);
});

test('a parentId branches off an earlier message and keeps the other branch out of the history', async () => {
  const { db, provider, service } = setup(reply(['ok']));
  const conversation = service.createConversation();

  const first = await service.send({ conversationId: conversation.id, content: 'one' });
  await service.send({ conversationId: conversation.id, content: 'two' });
  const branched = await service.send({
    conversationId: conversation.id,
    content: 'two-alt',
    parentId: first.id
  });

  assert.deepEqual(provider.requests[2].messages, [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'two-alt' }
  ]);
  assert.equal(db.getConversation(conversation.id)!.activeLeafId, branched.id);
  assert.equal(db.getMessages(conversation.id).length, 6);
  assert.deepEqual(
    db.getActivePath(conversation.id).map((m) => m.content),
    ['one', 'ok', 'two-alt', 'ok']
  );
});

test('a provider failure is stored as an errored assistant message and reported, not thrown', async () => {
  const { db, service } = setup(async function* () {
    yield { type: 'token', text: 'par' };
    throw new Error('OpenRouter: 429 rate limited');
  });
  const conversation = service.createConversation();
  const { log, events } = recorder();

  const assistant = await service.send({ conversationId: conversation.id, content: 'hi' }, events);

  assert.equal(assistant.error, 'OpenRouter: 429 rate limited');
  assert.equal(assistant.content, 'par');
  assert.deepEqual(log, ['user:hi', 'start:test/model', 'token:par', 'error:OpenRouter: 429 rate limited']);
  assert.equal(db.getMessage(assistant.id)?.error, 'OpenRouter: 429 rate limited');
  assert.equal(db.getConversation(conversation.id)!.activeLeafId, assistant.id);
  assert.equal(service.isGenerating(conversation.id), false);
});

test('cancel keeps the partial reply and marks it cancelled', async () => {
  const { db, service } = setup(hanging());
  const conversation = service.createConversation();

  let sawToken!: () => void;
  const tokenSeen = new Promise<void>((resolve) => {
    sawToken = resolve;
  });
  const pending = service.send(
    { conversationId: conversation.id, content: 'hi' },
    { onToken: () => sawToken() }
  );
  await tokenSeen;

  assert.equal(service.isGenerating(conversation.id), true);
  assert.equal(service.cancel(conversation.id), true);

  const assistant = await pending;
  assert.equal(assistant.content, 'partial');
  assert.equal(assistant.finishReason, 'cancelled');
  assert.equal(assistant.error, undefined);
  assert.equal(db.getMessage(assistant.id)?.finishReason, 'cancelled');
  assert.equal(service.cancel(conversation.id), false);
});

test('a second send while a reply is streaming is refused as busy', async () => {
  const { service } = setup(hanging());
  const conversation = service.createConversation();

  let started!: () => void;
  const startSeen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = service.send(
    { conversationId: conversation.id, content: 'one' },
    { onStart: () => started() }
  );
  await startSeen;

  await assert.rejects(
    service.send({ conversationId: conversation.id, content: 'two' }),
    (error: ChatError) => error.code === 'busy'
  );

  service.cancel(conversation.id);
  await pending;
});

test('turns that cannot start throw a ChatError', async () => {
  const { service } = setup(reply(['ok']));

  await assert.rejects(
    service.send({ conversationId: 'missing', content: 'hi' }),
    (error: ChatError) => error.code === 'not_found'
  );

  const conversation = service.createConversation();
  await assert.rejects(
    service.send({ conversationId: conversation.id, content: '   ' }),
    (error: ChatError) => error.code === 'invalid'
  );
  await assert.rejects(
    service.send({ conversationId: conversation.id, content: 'hi', parentId: 'nope' }),
    (error: ChatError) => error.code === 'invalid'
  );

  const unconfigured = new ChatService(new Database(':memory:'), null);
  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(
    unconfigured.send({ conversationId: conversation.id, content: 'hi' }),
    (error: ChatError) => error.code === 'not_configured'
  );
});

test('a listener that throws does not break the turn', async () => {
  const { db, service } = setup(reply(['ok']));
  const conversation = service.createConversation();

  const assistant = await service.send(
    { conversationId: conversation.id, content: 'hi' },
    {
      onToken: () => {
        throw new Error('listener bug');
      }
    }
  );

  assert.equal(assistant.content, 'ok');
  assert.equal(assistant.error, undefined);
  assert.equal(db.getMessages(conversation.id).length, 2);
});
