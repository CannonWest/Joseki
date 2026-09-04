import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatToolCall } from '@maestroai/shared';
import {
  OpenRouterProvider,
  buildChatCompletionBody,
  extractUsage,
  filterModels,
  normalizeModelRecord,
  toWireMessages,
  type ChatStreamEvent,
  type CompletionsClient
} from '../src/providers/openrouter';
import { accumulateToolCallDeltas, finalizeToolCallDeltas } from '../src/providers/toolCalls';

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
  return { id: 'm', conversationId: 'c', parentId: null, createdAt: 0, ...partial };
}

test('buildChatCompletionBody maps params to their wire names and omits what is unset', () => {
  const body = buildChatCompletionBody(
    {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0.2, maxTokens: 100, topP: 0.9, stop: ['END'] }
    },
    true
  );
  assert.deepEqual(body, {
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    max_tokens: 100,
    top_p: 0.9,
    stop: ['END'],
    stream: true
  });
});

test('buildChatCompletionBody forwards tools and tool_choice', () => {
  const tools = [{ type: 'function' as const, function: { name: 'run_workflow', parameters: {} } }];
  const body = buildChatCompletionBody({ model: 'm', messages: [], tools, toolChoice: 'none' }, false);
  assert.equal(body.tools, tools);
  assert.equal(body.tool_choice, 'none');
  assert.equal('stream' in body, false);
});

test('toWireMessages puts the system prompt first and drops empty failed assistant turns', () => {
  const wire = toWireMessages(
    [
      message({ id: 'u1', role: 'user', content: 'hello' }),
      message({ id: 'a1', role: 'assistant', content: '', error: 'boom' }),
      message({ id: 'u2', role: 'user', content: 'again' }),
      message({ id: 'a2', role: 'assistant', content: 'hi there' })
    ],
    '  be brief  '
  );
  assert.deepEqual(wire, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'hi there' }
  ]);
});

test('toWireMessages keeps tool calls and tool results in OpenAI shape', () => {
  const call: ChatToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'run_workflow', arguments: '{"id":"w"}' }
  };
  const wire = toWireMessages([
    message({ role: 'assistant', content: '', toolCalls: [call] }),
    message({ role: 'tool', content: 'done', toolCallId: 'call_1' })
  ]);
  assert.deepEqual(wire, [
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' }
  ]);
});

test('normalizeModelRecord converts per-token prices to per-million and fills defaults', () => {
  const model = normalizeModelRecord({
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    context_length: 128000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0.00000015', completion: '0.0000006', image: '0.001' },
    top_provider: { max_completion_tokens: 16384 },
    supported_parameters: ['temperature', 'tools']
  });
  assert.equal(model.pricing.prompt, 0.15);
  assert.equal(model.pricing.completion, 0.6);
  assert.equal(model.pricing.image, 0.001);
  assert.equal(model.pricing.request, null);
  assert.equal(model.contextLength, 128000);
  assert.equal(model.maxCompletionTokens, 16384);
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.deepEqual(model.supportedParameters, ['temperature', 'tools']);

  const bare = normalizeModelRecord({ id: 'x/y' });
  assert.equal(bare.name, 'x/y');
  assert.deepEqual(bare.inputModalities, []);
  assert.equal(bare.pricing.prompt, null);
  assert.equal(bare.contextLength, undefined);
});

test('filterModels matches every term against id, name and description, case-insensitively', () => {
  const models = [
    normalizeModelRecord({ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }),
    normalizeModelRecord({ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', description: 'Fast and cheap' })
  ];
  assert.equal(filterModels(models, '').length, 2);
  assert.deepEqual(filterModels(models, 'CLAUDE').map((m) => m.id), ['anthropic/claude-sonnet-4']);
  assert.deepEqual(filterModels(models, 'mini cheap').map((m) => m.id), ['openai/gpt-4o-mini']);
  assert.deepEqual(filterModels(models, 'mini claude'), []);
});

test('extractUsage reads counts, cache details and cost', () => {
  const { tokenUsage, cost } = extractUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    cost: 0.00042,
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 10 }
  });
  assert.deepEqual(tokenUsage, {
    prompt: 120,
    completion: 30,
    total: 150,
    cachedTokens: 100,
    cacheWriteTokens: 20,
    reasoningTokens: 10
  });
  assert.equal(cost, 0.00042);
  assert.deepEqual(extractUsage(undefined), {
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    cost: undefined
  });

  // BYOK: OpenRouter's own cost is 0 and the upstream spend is in cost_details
  const byok = extractUsage({
    prompt_tokens: 9,
    completion_tokens: 5,
    total_tokens: 14,
    cost: 0,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0.00000435 }
  });
  assert.equal(byok.cost, 0.00000435);
  assert.deepEqual(byok.tokenUsage, { prompt: 9, completion: 5, total: 14, byok: true });
});

test('tool-call deltas accumulate by index and finalize in order', () => {
  const acc = new Map<number, ChatToolCall>();
  accumulateToolCallDeltas(acc, [{ index: 1, id: 'call_b', function: { name: 'second', arguments: '{}' } }]);
  accumulateToolCallDeltas(acc, [{ index: 0, id: 'call_a', function: { name: 'fir' } }]);
  accumulateToolCallDeltas(acc, [
    { index: 0, function: { name: 'st', arguments: '{"a"' } },
    { index: 0, function: { arguments: ':1}' } }
  ]);
  assert.deepEqual(finalizeToolCallDeltas(acc), [
    { id: 'call_a', type: 'function', function: { name: 'first', arguments: '{"a":1}' } },
    { id: 'call_b', type: 'function', function: { name: 'second', arguments: '{}' } }
  ]);
});

// ---- streaming assembly through a fake SDK client ----

function fakeClient(chunks: unknown[]) {
  const calls: Array<{ body: Record<string, unknown>; signal?: AbortSignal }> = [];
  const client: CompletionsClient = {
    chat: {
      completions: {
        async create(body, options) {
          calls.push({ body, signal: options?.signal });
          if (!body.stream) return chunks[0];
          return (async function* () {
            for (const chunk of chunks) {
              if (options?.signal?.aborted) {
                const error = new Error('Request was aborted.');
                error.name = 'AbortError';
                throw error;
              }
              yield chunk;
            }
          })();
        }
      }
    }
  };
  return { client, calls };
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('chatStream assembles tokens, reasoning, tool calls and the final usage', async () => {
  const { client, calls } = fakeClient([
    { model: 'openai/gpt-4o-mini', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo', reasoning: 'think' } }] },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_', arguments: '{"id"' } }] } }
      ]
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { name: 'workflow', arguments: ':"w"}' } }] },
          finish_reason: 'tool_calls'
        }
      ]
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 } }
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'test', client });

  const events = await collect(
    provider.chatStream({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0 }
    })
  );

  assert.deepEqual(events.slice(0, 3), [
    { type: 'token', text: 'Hel' },
    { type: 'reasoning', text: 'think' },
    { type: 'token', text: 'lo' }
  ]);
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  if (done.type !== 'done') return;
  assert.equal(done.result.content, 'Hello');
  assert.equal(done.result.reasoning, 'think');
  assert.equal(done.result.model, 'openai/gpt-4o-mini');
  assert.equal(done.result.finishReason, 'tool_calls');
  assert.equal(done.result.cost, 0.001);
  assert.deepEqual(done.result.tokenUsage, { prompt: 10, completion: 5, total: 15 });
  assert.deepEqual(done.result.toolCalls, [
    { id: 'call_1', type: 'function', function: { name: 'run_workflow', arguments: '{"id":"w"}' } }
  ]);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.temperature, 0);
});

test('chatStream ends with what streamed so far when the signal is aborted', async () => {
  const { client } = fakeClient([
    { choices: [{ delta: { content: 'partial' } }] },
    { choices: [{ delta: { content: ' more' } }] }
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'test', client });
  const controller = new AbortController();

  const stream = provider.chatStream({ model: 'm', messages: [] }, { signal: controller.signal });
  const first = await stream.next();
  assert.deepEqual(first.value, { type: 'token', text: 'partial' });
  controller.abort();

  assert.deepEqual(await collect(stream), [
    {
      type: 'done',
      result: {
        content: 'partial',
        model: 'm',
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        cost: undefined,
        finishReason: 'cancelled'
      }
    }
  ]);
});

test('chat wraps API failures in a ProviderError that keeps the status', async () => {
  const client: CompletionsClient = {
    chat: {
      completions: {
        async create() {
          const error = new Error('401 No auth credentials found') as Error & { status?: number };
          error.status = 401;
          throw error;
        }
      }
    }
  };
  const provider = new OpenRouterProvider({ apiKey: 'test', client });
  await assert.rejects(
    provider.chat({ model: 'm', messages: [] }),
    (error: Error & { status?: number }) =>
      error.name === 'ProviderError' && error.status === 401 && /401/.test(error.message)
  );
});

test('chat reads a non-streaming response', async () => {
  const { client } = fakeClient([
    {
      model: 'openai/gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'Hello', reasoning: 'hmm' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cost: 0.00001 }
    }
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'test', client });
  const result = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(result, {
    content: 'Hello',
    model: 'openai/gpt-4o-mini',
    tokenUsage: { prompt: 4, completion: 1, total: 5 },
    cost: 0.00001,
    finishReason: 'stop',
    reasoning: 'hmm'
  });
});

// ---- catalog ----

function catalogFetch(record: (url: URL, init?: RequestInit) => void) {
  let fetches = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetches++;
    record(new URL(String(input)), init);
    return new Response(JSON.stringify({ data: [{ id: 'a/b', name: 'B' }, 'junk'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { fetchImpl, count: () => fetches };
}

test('listModels caches the catalog per filter set until the TTL expires', async () => {
  const { fetchImpl, count } = catalogFetch(() => {});
  const provider = new OpenRouterProvider({
    apiKey: 'test',
    fetchImpl,
    catalogTtlMs: 60_000,
    client: fakeClient([]).client
  });

  const first = await provider.listModels();
  const second = await provider.listModels();
  assert.equal(count(), 1);
  assert.deepEqual(first.map((m) => m.id), ['a/b']);
  assert.deepEqual(second, first);

  await provider.listModels({ category: 'programming' });
  assert.equal(count(), 2);
  await provider.listModels({}, { forceRefresh: true });
  assert.equal(count(), 3);

  const expiring = new OpenRouterProvider({
    apiKey: 'test',
    fetchImpl,
    catalogTtlMs: 0,
    client: fakeClient([]).client
  });
  await expiring.listModels();
  await expiring.listModels();
  assert.equal(count(), 5);
});

test('listModels sends the bearer token, attribution headers and filters', async () => {
  let seenUrl: URL | undefined;
  let seenHeaders: Record<string, string> = {};
  const { fetchImpl } = catalogFetch((url, init) => {
    seenUrl = url;
    seenHeaders = init?.headers as Record<string, string>;
  });
  const provider = new OpenRouterProvider({
    apiKey: 'sk-or-test',
    title: 'Smoke',
    referer: 'http://example.test',
    fetchImpl,
    client: fakeClient([]).client
  });

  await provider.listModels({ q: 'claude', zdr: true, category: '' });
  assert.ok(seenUrl);
  assert.equal(seenUrl.origin + seenUrl.pathname, 'https://openrouter.ai/api/v1/models');
  assert.equal(seenUrl.searchParams.get('q'), 'claude');
  assert.equal(seenUrl.searchParams.get('zdr'), 'true');
  assert.equal(seenUrl.searchParams.has('category'), false);
  assert.equal(seenHeaders.Authorization, 'Bearer sk-or-test');
  assert.equal(seenHeaders['X-OpenRouter-Title'], 'Smoke');
  assert.equal(seenHeaders['HTTP-Referer'], 'http://example.test');
});

test('listModels turns HTTP failures into a ProviderError', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  const provider = new OpenRouterProvider({ apiKey: 'test', fetchImpl, client: fakeClient([]).client });
  await assert.rejects(
    provider.listModels(),
    (error: Error & { status?: number }) => error.name === 'ProviderError' && error.status === 401
  );
});

test('fromEnv returns null without a key', () => {
  assert.equal(OpenRouterProvider.fromEnv({}), null);
  assert.equal(OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: '  ' }), null);
  assert.ok(OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: 'sk-or-test' }) instanceof OpenRouterProvider);
});
