import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatTokenUsage, ChatToolCall } from '@maestroai/shared';
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
import { ToolRegistry, ok } from '../src/tools/registry';

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

interface Turn {
  tokens?: string[];
  content?: string;
  toolCalls?: ChatToolCall[];
  usage?: Partial<ChatTokenUsage>;
  cost?: number;
}

/** Answers each provider call with the next scripted turn (the last one repeats). */
function turns(script: Turn[]): Script {
  let calls = 0;
  return async function* (request) {
    const turn = script[Math.min(calls++, script.length - 1)];
    for (const text of turn.tokens ?? []) yield { type: 'token', text };
    yield {
      type: 'done',
      result: {
        content: turn.content ?? (turn.tokens ?? []).join(''),
        model: request.model,
        tokenUsage: { prompt: 10, completion: 5, total: 15, ...turn.usage },
        cost: turn.cost ?? 0.001,
        finishReason: turn.toolCalls ? 'tool_calls' : 'stop',
        ...(turn.toolCalls ? { toolCalls: turn.toolCalls } : {})
      }
    };
  };
}

const call = (id: string, name: string, args: unknown): ChatToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});

function recorder() {
  const log: string[] = [];
  const events: ChatEvents = {
    onMessage: (m) => log.push(`${m.role}:${m.content}`),
    onStart: (e) => log.push(`start:${e.model}`),
    onToken: (e) => log.push(`token:${e.token}`),
    onReasoning: (e) => log.push(`reasoning:${e.text}`),
    onToolStart: (e) => log.push(`tool_start:${e.name}`),
    onToolEnd: (e) => log.push(`tool_end:${e.name}:${e.isError ? 'error' : 'ok'}`),
    onComplete: (e) => log.push(`complete:${e.message.content}`),
    onError: (e) => log.push(`error:${e.error}`)
  };
  return { log, events };
}

function setup(script: Script, tools?: ToolRegistry) {
  const db = new Database(':memory:');
  const provider = new FakeProvider(script);
  const service = new ChatService(db, provider, { defaultModel: 'test/model', tools });
  return { db, provider, service };
}

function toolRegistry() {
  return new ToolRegistry()
    .register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      async execute(args) {
        return ok(`echo:${JSON.stringify(args)}`);
      }
    })
    .register({
      name: 'big',
      description: 'big',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return ok('x'.repeat(20_000));
      }
    })
    .register({
      name: 'boom',
      description: 'boom',
      parameters: { type: 'object', properties: {} },
      async execute() {
        throw new Error('kaboom');
      }
    });
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
  assert.equal('tools' in provider.requests[0], false);
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

// ---- tools ----

test('a tool turn stores the call, the result and the final reply in one chain', async () => {
  const { db, provider, service } = setup(
    turns([
      { content: 'Checking…', toolCalls: [call('c1', 'echo', { a: 1 })], usage: { prompt: 10, completion: 5, total: 15 }, cost: 0.001 },
      { tokens: ['Done.'], usage: { prompt: 20, completion: 2, total: 22 }, cost: 0.002 }
    ]),
    toolRegistry()
  );
  const conversation = service.createConversation();
  const { log, events } = recorder();

  const reply = await service.send({ conversationId: conversation.id, content: 'go' }, events);

  assert.deepEqual(log, [
    'user:go',
    'start:test/model',
    'assistant:Checking…',
    'tool_start:echo',
    'tool_end:echo:ok',
    'tool:echo:{"a":1}',
    'start:test/model',
    'token:Done.',
    'complete:Done.'
  ]);

  const stored = db.getMessages(conversation.id);
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(stored.every((m, i) => i === 0 || m.parentId === stored[i - 1].id), 'each message parents the previous one');

  const toolTurn = stored[1];
  assert.equal(toolTurn.content, 'Checking…');
  assert.deepEqual(toolTurn.toolCalls, [call('c1', 'echo', { a: 1 })]);
  assert.equal(toolTurn.finishReason, 'tool_calls');
  assert.deepEqual(toolTurn.tokenUsage, { prompt: 10, completion: 5, total: 15 });

  const toolResult = stored[2];
  assert.equal(toolResult.toolCallId, 'c1');
  assert.equal(toolResult.content, 'echo:{"a":1}');
  assert.equal(typeof toolResult.latencyMs, 'number');
  assert.equal(toolResult.error, undefined);

  assert.equal(reply.id, stored[3].id);
  assert.equal(reply.content, 'Done.');
  assert.deepEqual(reply.tokenUsage, { prompt: 30, completion: 7, total: 37 });
  assert.equal(reply.cost, 0.003);
  assert.equal(db.getConversation(conversation.id)!.activeLeafId, reply.id);
  assert.equal(db.getActivePath(conversation.id).length, 4);

  assert.deepEqual(provider.requests[0].tools?.map((t) => t.function.name), ['echo', 'big', 'boom']);
  assert.equal(provider.requests[0].toolChoice, 'auto');
  assert.deepEqual(provider.requests[1].messages, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Checking…', tool_calls: [call('c1', 'echo', { a: 1 })] },
    { role: 'tool', tool_call_id: 'c1', content: 'echo:{"a":1}' }
  ]);
});

test('the next turn replays the stored tool exchange to the model', async () => {
  const { provider, service } = setup(
    turns([{ toolCalls: [call('c1', 'echo', {})] }, { content: 'first' }, { content: 'second' }]),
    toolRegistry()
  );
  const conversation = service.createConversation();
  await service.send({ conversationId: conversation.id, content: 'one' });
  await service.send({ conversationId: conversation.id, content: 'two' });

  assert.deepEqual(provider.requests[2].messages, [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'echo', {})] },
    { role: 'tool', tool_call_id: 'c1', content: 'echo:{}' },
    { role: 'assistant', content: 'first' },
    { role: 'user', content: 'two' }
  ]);
});

test('params.tools false makes a plain turn, per conversation or per message', async () => {
  const { provider, service } = setup(turns([{ content: 'plain' }]), toolRegistry());

  const off = service.createConversation({ params: { tools: false } });
  await service.send({ conversationId: off.id, content: 'hi' });
  assert.equal('tools' in provider.requests[0], false);

  const on = service.createConversation();
  await service.send({ conversationId: on.id, content: 'hi', params: { tools: false } });
  assert.equal('tools' in provider.requests[1], false);
  await service.send({ conversationId: on.id, content: 'again' });
  assert.equal(provider.requests[2].tools?.length, 3);
});

test('a failing tool is stored as an errored tool message and the model still answers', async () => {
  const { db, service } = setup(turns([{ toolCalls: [call('c1', 'boom', {})] }, { content: 'sorry' }]), toolRegistry());
  const conversation = service.createConversation();
  const { log, events } = recorder();

  const reply = await service.send({ conversationId: conversation.id, content: 'go' }, events);

  const toolResult = db.getMessages(conversation.id)[2];
  assert.equal(toolResult.role, 'tool');
  assert.equal(toolResult.error, 'execution_error');
  assert.match(toolResult.content, /kaboom/);
  assert.ok(log.includes('tool_end:boom:error'));
  assert.equal(reply.content, 'sorry');
  assert.equal(reply.error, undefined);
});

test('a large tool result is capped in storage but reaches the model whole', async () => {
  const { db, provider, service } = setup(turns([{ toolCalls: [call('c1', 'big', {})] }, { content: 'ok' }]), toolRegistry());
  const conversation = service.createConversation();

  await service.send({ conversationId: conversation.id, content: 'go' });

  const stored = db.getMessages(conversation.id)[2];
  assert.ok(stored.content.length < 16_100);
  assert.match(stored.content, /\[tool result truncated at 16000 chars\]$/);
  assert.equal((provider.requests[1].messages[2] as { content: string }).content.length, 20_000);
});

test('cancelling during a tool turn stores what happened and a stopped reply', async () => {
  const db = new Database(':memory:');
  const provider = new FakeProvider(turns([{ toolCalls: [call('c1', 'stop', {})] }, { content: 'never' }]));
  let service!: ChatService;
  const registry = new ToolRegistry().register({
    name: 'stop',
    description: 'cancels the turn from inside',
    parameters: { type: 'object', properties: {} },
    async execute(_args, context) {
      service.cancel(context.conversationId);
      return ok('stopped');
    }
  });
  service = new ChatService(db, provider, { defaultModel: 'test/model', tools: registry });
  const conversation = service.createConversation();

  const reply = await service.send({ conversationId: conversation.id, content: 'go' });

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(db.getMessages(conversation.id).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(reply.finishReason, 'cancelled');
  assert.equal(reply.content, '');
  assert.equal(reply.error, undefined);
  assert.equal(service.isGenerating(conversation.id), false);
});
