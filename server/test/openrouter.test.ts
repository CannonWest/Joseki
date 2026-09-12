import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatToolCall } from '@joseki/shared';
import {
  OpenRouterProvider,
  applyModelCapabilities,
  applyReasoningDefault,
  buildChatCompletionBody,
  extractUsage,
  filterModels,
  isBatchOnly,
  mergeReasoningDetails,
  normalizeModelRecord,
  normalizeReasoning,
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

test('chatStream marks the reply cancelled when the SDK ends an aborted stream quietly', async () => {
  // openai-node swallows the AbortError and just stops iterating.
  const controller = new AbortController();
  const client: CompletionsClient = {
    chat: {
      completions: {
        async create(_body, options) {
          return (async function* () {
            yield { choices: [{ delta: { content: 'partial' } }] };
            controller.abort();
            if (options?.signal?.aborted) return;
            yield { choices: [{ delta: { content: ' more' } }] };
          })();
        }
      }
    }
  };
  const provider = new OpenRouterProvider({ apiKey: 'test', client });

  const events = await collect(provider.chatStream({ model: 'm', messages: [] }, { signal: controller.signal }));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  if (done.type !== 'done') return;
  assert.equal(done.result.content, 'partial');
  assert.equal(done.result.finishReason, 'cancelled');
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

test('chat and chatStream carry the provider the gateway routed to', async () => {
  const plain = new OpenRouterProvider({
    apiKey: 'test',
    client: fakeClient([
      {
        model: 'openai/gpt-4o-mini',
        provider: 'Azure',
        choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 }
      }
    ]).client
  });
  const result = await plain.chat({ model: 'm', messages: [] });
  assert.equal(result.provider, 'Azure');

  const streamed = new OpenRouterProvider({
    apiKey: 'test',
    client: fakeClient([
      { model: 'openai/gpt-4o-mini', provider: 'OpenAI', choices: [{ delta: { content: 'Hel' } }] },
      { provider: 'OpenAI', choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { provider: '', choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } }
    ]).client
  });
  const events = await collect(streamed.chatStream({ model: 'm', messages: [] }));
  const done = events.find((event) => event.type === 'done');
  assert.equal(done?.type === 'done' ? done.result.provider : undefined, 'OpenAI');

  const silent = new OpenRouterProvider({
    apiKey: 'test',
    client: fakeClient([{ choices: [{ message: { role: 'assistant', content: 'Hi' } }] }]).client
  });
  assert.equal('provider' in (await silent.chat({ model: 'm', messages: [] })), false);
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

test('chatStream collects reasoning_details, merging streamed text fragments', async () => {
  const { client } = fakeClient([
    { choices: [{ delta: { reasoning: 'Let me ', reasoning_details: [{ type: 'reasoning.text', text: 'Let me ', id: 'r1', format: 'anthropic-claude-v1', index: 0 }] } }] },
    { choices: [{ delta: { reasoning: 'think.', reasoning_details: [{ type: 'reasoning.text', text: 'think.', id: 'r1', format: 'anthropic-claude-v1', index: 0, signature: 'sig' }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'xyz', id: 'r2', format: 'anthropic-claude-v1', index: 1 }] } }] },
    { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'test', client });
  const events = await collect(provider.chatStream({ model: 'm', messages: [] }));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  if (done.type !== 'done') return;
  assert.equal(done.result.reasoning, 'Let me think.');
  assert.deepEqual(done.result.reasoningDetails, [
    { type: 'reasoning.text', text: 'Let me think.', id: 'r1', format: 'anthropic-claude-v1', index: 0, signature: 'sig' },
    { type: 'reasoning.encrypted', data: 'xyz', id: 'r2', format: 'anthropic-claude-v1', index: 1 }
  ]);
});

test('chat (non-streaming) keeps reasoning_details as sent', async () => {
  const details = [{ type: 'reasoning.summary', summary: 'short', id: 's1', format: 'openai-responses-v1', index: 0 }];
  const { client } = fakeClient([
    { model: 'm', choices: [{ message: { role: 'assistant', content: 'Hi', reasoning_details: details }, finish_reason: 'stop' }], usage: {} }
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'test', client });
  const result = await provider.chat({ model: 'm', messages: [] });
  assert.deepEqual(result.reasoningDetails, details);
  assert.equal(result.reasoning, undefined);
});

test('mergeReasoningDetails keeps separate indexes and non-text items apart', () => {
  const acc: unknown[] = [];
  mergeReasoningDetails(acc, [{ type: 'reasoning.text', text: 'a', index: 0 }]);
  mergeReasoningDetails(acc, [{ type: 'reasoning.text', text: 'b', index: 0 }, { type: 'reasoning.text', text: 'c', index: 1 }]);
  mergeReasoningDetails(acc, [{ type: 'reasoning.summary', summary: 's', index: 2 }, 'junk', { type: 'reasoning.text', text: 'd', index: 2 }]);
  assert.deepEqual(acc, [
    { type: 'reasoning.text', text: 'ab', index: 0 },
    { type: 'reasoning.text', text: 'c', index: 1 },
    { type: 'reasoning.summary', summary: 's', index: 2 },
    { type: 'reasoning.text', text: 'd', index: 2 }
  ]);
});

test('toWireMessages replays reasoning only with tool calls, structured details first', () => {
  const call: ChatToolCall = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } };
  const details = [{ type: 'reasoning.text', text: 'why', index: 0 }];
  const wire = toWireMessages([
    message({ id: 'a1', role: 'assistant', content: 'plain', reasoning: 'ignored' }),
    message({ id: 'a2', role: 'assistant', content: '', toolCalls: [call], reasoning: 'why', reasoningDetails: details }),
    message({ id: 't2', role: 'tool', content: 'r', toolCallId: 'c1' }),
    message({ id: 'a3', role: 'assistant', content: '', toolCalls: [call], reasoning: 'text only' })
  ]);
  assert.deepEqual(wire, [
    { role: 'assistant', content: 'plain' },
    { role: 'assistant', content: '', tool_calls: [call], reasoning_details: details },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
    { role: 'assistant', content: '', tool_calls: [call], reasoning: 'text only' }
  ]);
});

test('fromEnv returns null without a key', () => {
  assert.equal(OpenRouterProvider.fromEnv({}), null);
  assert.equal(OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: '  ' }), null);
  assert.ok(OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: 'sk-or-test' }) instanceof OpenRouterProvider);
});

test('buildChatCompletionBody forwards routing as the provider object and fallbacks as models', () => {
  const body = buildChatCompletionBody(
    {
      model: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      params: {
        routing: {
          order: ['anthropic', ' google-vertex '],
          only: [],
          ignore: [''],
          allowFallbacks: false,
          dataCollection: 'deny',
          zdr: true,
          quantizations: ['fp8', 'bf16'],
          sort: 'throughput',
          maxPrice: { prompt: 3, completion: 15 },
          preferredMinThroughput: 40,
          preferredMaxLatency: 2.5,
          fallbackModels: ['openai/gpt-4o-mini', '']
        }
      }
    },
    false
  );
  assert.deepEqual(body.provider, {
    order: ['anthropic', 'google-vertex'],
    allow_fallbacks: false,
    data_collection: 'deny',
    zdr: true,
    quantizations: ['fp8', 'bf16'],
    sort: 'throughput',
    max_price: { prompt: 3, completion: 15 },
    preferred_min_throughput: 40,
    preferred_max_latency: 2.5
  });
  assert.deepEqual(body.models, ['openai/gpt-4o-mini']);
  assert.equal('routing' in body, false);
});

test('buildChatCompletionBody takes comma-separated provider lists and sends nothing for empty extension objects', () => {
  const listed = buildChatCompletionBody(
    {
      model: 'm',
      messages: [],
      params: { routing: { order: 'anthropic, google-vertex,' as unknown as string[] } }
    },
    false
  );
  assert.deepEqual(listed.provider, { order: ['anthropic', 'google-vertex'] });

  const empty = buildChatCompletionBody(
    { model: 'm', messages: [], params: { routing: {}, sampling: {}, reasoning: {} } },
    false
  );
  assert.equal('provider' in empty, false);
  assert.equal('models' in empty, false);
  assert.equal('reasoning' in empty, false);
});

test('buildChatCompletionBody forces require_parameters with tools unless routing set it', () => {
  const tools = [{ type: 'function' as const, function: { name: 'echo', parameters: {} } }];
  const forced = buildChatCompletionBody({ model: 'm', messages: [], tools }, false);
  assert.deepEqual(forced.provider, { require_parameters: true });

  const explicit = buildChatCompletionBody(
    { model: 'm', messages: [], tools, params: { routing: { requireParameters: false } } },
    false
  );
  assert.deepEqual(explicit.provider, { require_parameters: false });

  const plain = buildChatCompletionBody(
    { model: 'm', messages: [], params: { routing: { zdr: true } } },
    false
  );
  assert.deepEqual(plain.provider, { zdr: true });
});

test('buildChatCompletionBody forwards the sampling extensions as top-level keys', () => {
  const body = buildChatCompletionBody(
    {
      model: 'm',
      messages: [],
      params: { sampling: { topK: 40, minP: 0.05, topA: 0.2, repetitionPenalty: 1.1, seed: 7 } }
    },
    false
  );
  assert.equal(body.top_k, 40);
  assert.equal(body.min_p, 0.05);
  assert.equal(body.top_a, 0.2);
  assert.equal(body.repetition_penalty, 1.1);
  assert.equal(body.seed, 7);
  assert.equal('sampling' in body, false);

  const unset = buildChatCompletionBody(
    { model: 'm', messages: [], params: { sampling: { topK: undefined, seed: Number.NaN } } },
    false
  );
  assert.equal('top_k' in unset, false);
  assert.equal('seed' in unset, false);
});

test('buildChatCompletionBody maps reasoning: a budget is clamped and beats effort, and max_tokens makes room for it', () => {
  const effort = buildChatCompletionBody(
    { model: 'm', messages: [], params: { maxTokens: 4096, reasoning: { effort: 'high', exclude: true } } },
    false
  );
  assert.deepEqual(effort.reasoning, { effort: 'high', exclude: true });
  assert.equal(effort.max_tokens, 4096);

  const budget = buildChatCompletionBody(
    { model: 'm', messages: [], params: { maxTokens: 4096, reasoning: { effort: 'high', maxTokens: 8000 } } },
    false
  );
  assert.deepEqual(budget.reasoning, { max_tokens: 8000 });
  assert.equal(budget.max_tokens, 4096 + 8000);

  const fits = buildChatCompletionBody(
    { model: 'm', messages: [], params: { maxTokens: 4096, reasoning: { maxTokens: 2000 } } },
    false
  );
  assert.deepEqual(fits.reasoning, { max_tokens: 2000 });
  assert.equal(fits.max_tokens, 4096);

  const floored = buildChatCompletionBody({ model: 'm', messages: [], params: { reasoning: { maxTokens: 500 } } }, false);
  assert.deepEqual(floored.reasoning, { max_tokens: 1024 });
  assert.equal('max_tokens' in floored, false);
  const capped = buildChatCompletionBody({ model: 'm', messages: [], params: { reasoning: { maxTokens: 500_000 } } }, false);
  assert.deepEqual(capped.reasoning, { max_tokens: 128_000 });

  const off = buildChatCompletionBody({ model: 'm', messages: [], params: { reasoning: { enabled: false } } }, false);
  assert.deepEqual(off.reasoning, { enabled: false });
  const on = buildChatCompletionBody({ model: 'm', messages: [], params: { reasoning: { enabled: true } } }, false);
  assert.deepEqual(on.reasoning, { enabled: true });

  const junk = buildChatCompletionBody(
    { model: 'm', messages: [], params: { reasoning: { effort: 'turbo' as any, maxTokens: -5, exclude: false } } },
    false
  );
  assert.equal('reasoning' in junk, false);
});

test('normalizeReasoning reads the catalog reasoning object and keeps only known efforts', () => {
  assert.equal(normalizeReasoning(undefined), undefined);
  assert.equal(normalizeReasoning('yes'), undefined);
  assert.deepEqual(normalizeReasoning({}), {});
  assert.deepEqual(
    normalizeReasoning({
      mandatory: false,
      default_enabled: false,
      supported_efforts: ['max', 'xhigh', 'high', 'turbo', 7],
      default_effort: 'high',
      supports_max_tokens: true
    }),
    {
      mandatory: false,
      defaultEnabled: false,
      supportedEfforts: ['max', 'xhigh', 'high'],
      defaultEffort: 'high',
      supportsMaxTokens: true
    }
  );
  assert.deepEqual(normalizeReasoning({ mandatory: true, default_effort: 'turbo' }), { mandatory: true });
  assert.deepEqual(normalizeModelRecord({ id: 'x/y', reasoning: { mandatory: true } }).reasoning, { mandatory: true });
  assert.equal(normalizeModelRecord({ id: 'x/y' }).reasoning, undefined);
});

test('applyReasoningDefault fills the model default effort only when the conversation set nothing', () => {
  const model = normalizeModelRecord({
    id: 'anthropic/claude-opus-4.8',
    reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['high', 'medium'], default_effort: 'high' }
  });
  const base = { temperature: 0.7, maxTokens: 4096 };
  assert.deepEqual(applyReasoningDefault(base, model), { ...base, reasoning: { effort: 'high' } });
  assert.deepEqual(applyReasoningDefault({ ...base, reasoning: { exclude: true } }, model), {
    ...base,
    reasoning: { exclude: true, effort: 'high' }
  });

  for (const reasoning of [{ effort: 'low' as const }, { maxTokens: 2048 }, { enabled: false }, { enabled: true }]) {
    const params = { ...base, reasoning };
    assert.equal(applyReasoningDefault(params, model), params);
  }
  assert.equal(applyReasoningDefault(base, undefined), base);
  assert.equal(applyReasoningDefault(base, normalizeModelRecord({ id: 'x/y' })), base);
  assert.equal(applyReasoningDefault(base, normalizeModelRecord({ id: 'x/y', reasoning: { mandatory: true } })), base);
});

test('applyModelCapabilities drops unsupported params, withholds tools and keeps the reasoning default', () => {
  // gpt-5.4-nano as the catalog lists it: no temperature / top_p / penalties,
  // max_tokens under both names, seed but no other sampling knob.
  const nano = normalizeModelRecord({
    id: 'openai/gpt-5.4-nano',
    supported_parameters: ['max_completion_tokens', 'max_tokens', 'reasoning', 'seed', 'tools', 'tool_choice'],
    reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['high', 'medium'], default_effort: 'medium' }
  });
  assert.deepEqual(
    applyModelCapabilities(
      {
        temperature: 0.7,
        maxTokens: 4096,
        topP: 0.9,
        frequencyPenalty: 0.1,
        stop: ['END'],
        sampling: { topK: 40, seed: 7 },
        routing: { zdr: true }
      },
      nano
    ),
    { maxTokens: 4096, sampling: { seed: 7 }, routing: { zdr: true }, reasoning: { effort: 'medium' } }
  );

  const plain = normalizeModelRecord({ id: 'x/chat', supported_parameters: ['temperature', 'max_tokens'] });
  assert.deepEqual(applyModelCapabilities({ temperature: 0.2, reasoning: { effort: 'high' }, sampling: { topK: 5 } }, plain), {
    temperature: 0.2,
    tools: false
  });
  assert.deepEqual(applyModelCapabilities({ temperature: 0.2, tools: false }, plain), { temperature: 0.2, tools: false });

  const unknown = { temperature: 0.2, sampling: { topK: 1 } };
  assert.equal(applyModelCapabilities(unknown, undefined), unknown);
});

test('findModel looks a model up in the cached catalog', async () => {
  const { fetchImpl, count } = catalogFetch(() => {});
  const provider = new OpenRouterProvider({
    apiKey: 'test',
    fetchImpl,
    catalogTtlMs: 60_000,
    client: fakeClient([]).client
  });
  assert.equal((await provider.findModel('a/b'))?.name, 'B');
  assert.equal(await provider.findModel('a/zzz'), undefined);
  assert.equal(count(), 1);
});

test('getModelEndpoints normalizes the roster, encodes the id, caches per model and rejects a bare id', async () => {
  const seen: URL[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(new URL(String(input)));
    return new Response(
      JSON.stringify({
        data: {
          id: 'openai/gpt-4o-mini',
          name: 'OpenAI: GPT-4o-mini',
          endpoints: [
            {
              name: 'Azure | openai/gpt-4o-mini',
              provider_name: 'Azure',
              tag: 'azure',
              context_length: 128000,
              max_completion_tokens: 16384,
              max_prompt_tokens: null,
              pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000075', discount: 0 },
              quantization: 'unknown',
              supported_parameters: ['temperature', 'tools'],
              supports_implicit_caching: false,
              status: 0,
              uptime_last_30m: 99.8,
              uptime_last_5m: 100,
              uptime_last_1d: 99.6,
              latency_last_30m: null,
              throughput_last_30m: 71.2
            },
            { provider_name: 'OpenAI' },
            'junk'
          ]
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  const provider = new OpenRouterProvider({
    apiKey: 'test',
    fetchImpl,
    catalogTtlMs: 60_000,
    client: fakeClient([]).client
  });

  const roster = await provider.getModelEndpoints('openai/gpt-4o-mini:free');
  assert.equal(seen[0].pathname, '/api/v1/models/openai/gpt-4o-mini%3Afree/endpoints');
  assert.equal(roster.id, 'openai/gpt-4o-mini');
  assert.equal(roster.name, 'OpenAI: GPT-4o-mini');
  assert.equal(roster.endpoints.length, 2);
  assert.deepEqual(roster.endpoints[0], {
    providerName: 'Azure',
    providerSlug: 'azure',
    name: 'Azure | openai/gpt-4o-mini',
    contextLength: 128000,
    maxPromptTokens: undefined,
    maxCompletionTokens: 16384,
    pricing: { prompt: 0.15, completion: 0.6, request: null, image: null },
    quantization: 'unknown',
    supportedParameters: ['temperature', 'tools'],
    supportsImplicitCaching: false,
    latencyLast30m: null,
    throughputLast30m: 71.2,
    uptimeLast5m: 100,
    uptimeLast30m: 99.8,
    uptimeLast1d: 99.6,
    status: 0
  });
  assert.equal(roster.endpoints[1].providerSlug, 'OpenAI');
  assert.equal(roster.endpoints[1].name, 'OpenAI');
  assert.equal(roster.endpoints[1].pricing.prompt, null);

  await provider.getModelEndpoints('openai/gpt-4o-mini:free');
  assert.equal(seen.length, 1);
  await provider.getModelEndpoints('openai/gpt-4o-mini:free', { forceRefresh: true });
  assert.equal(seen.length, 2);
  await provider.getModelEndpoints('openai/gpt-4o');
  assert.equal(seen.length, 3);

  const badRequest = (error: Error & { status?: number }) => error.name === 'ProviderError' && error.status === 400;
  await assert.rejects(provider.getModelEndpoints('gpt-4o-mini'), badRequest);
  await assert.rejects(provider.getModelEndpoints('openai/'), badRequest);
  assert.equal(seen.length, 3);
});

// ============ Service tier, and the models a completion cannot reach ============

test('a service tier rides the body as service_tier, and saying nothing sends nothing', () => {
  const base = { model: 'openai/gpt-4o-mini', messages: [{ role: 'user' as const, content: 'hi' }] };

  assert.equal(buildChatCompletionBody({ ...base, params: { serviceTier: 'flex' } }, false).service_tier, 'flex');
  assert.equal(
    buildChatCompletionBody({ ...base, params: { serviceTier: 'priority' } }, false).service_tier,
    'priority'
  );
  assert.equal('service_tier' in buildChatCompletionBody({ ...base, params: {} }, false), false);
});

test('the tier survives shaping, because no model advertises it as a parameter', () => {
  // applyModelCapabilities drops what a model does not list under
  // supported_parameters. No model lists service_tier — it picks a class of
  // endpoint rather than asking the model for anything — so it must not be
  // treated as one of those parameters, or it would be dropped every time.
  const model = {
    id: 'openai/gpt-4o-mini',
    name: 'OpenAI: GPT-4o-mini',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedParameters: ['max_tokens'],
    pricing: { prompt: 0.15, completion: 0.6, request: null, image: null }
  };
  const shaped = applyModelCapabilities({ serviceTier: 'flex', temperature: 0.5 }, model as any);
  assert.equal(shaped.serviceTier, 'flex', 'kept');
  assert.equal(shaped.temperature, undefined, 'dropped, since the model does not list it');
});

test('a batch-only model is the one a completion cannot reach', () => {
  assert.equal(isBatchOnly({ id: 'google/gemini-3.8-flash:batch' }), true);
  assert.equal(isBatchOnly({ id: 'google/gemini-3.8-flash' }), false);
  // No other suffix is batch-only, and a slug that merely starts the same is not one.
  assert.equal(isBatchOnly({ id: 'meta-llama/llama-3.1-8b-instruct:free' }), false);
  assert.equal(isBatchOnly({ id: 'anthropic/claude-haiku-4.5:batching' }), false);
});
