import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMAdapter, OpenAIGenerator, OpenRouterGenerator, toChatRequest } from '../src/adapters/llm';
import type { ChatRequest, ChatResult, ChatStreamEvent } from '../src/providers/openrouter';

const result = (over: Partial<ChatResult> = {}): ChatResult => ({
  content: 'the answer',
  model: 'openai/gpt-4o-mini',
  tokenUsage: { prompt: 12, completion: 5, total: 17 },
  cost: 0.00042,
  ...over
});

/** Records the request and answers with a canned result, streaming or not. */
function fakeProvider(reply: ChatResult, tokens: string[] = ['the ', 'answer']) {
  const calls: Array<{ mode: 'chat' | 'stream'; request: ChatRequest }> = [];
  return {
    calls,
    async chat(request: ChatRequest) {
      calls.push({ mode: 'chat', request });
      return reply;
    },
    async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
      calls.push({ mode: 'stream', request });
      for (const text of tokens) yield { type: 'token', text };
      yield { type: 'done', result: reply };
    }
  };
}

const params = {
  model: 'openai/gpt-4o-mini',
  systemPrompt: 'Be brief.',
  userPrompt: 'Summarize: rivers',
  temperature: 0.3,
  maxTokens: 200
};

test('toChatRequest puts the system prompt first and maps the sampling params', () => {
  assert.deepEqual(toChatRequest(params), {
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Summarize: rivers' }
    ],
    params: { temperature: 0.3, maxTokens: 200 }
  });
});

test('a blank system prompt is left out rather than sent empty', () => {
  const request = toChatRequest({ ...params, systemPrompt: '   ' });
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Summarize: rivers' }]);
});

test('without a token callback the generator uses one completion and returns usage, model and cost', async () => {
  const provider = fakeProvider(result());
  const out = await new OpenRouterGenerator(provider).generate(params);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].mode, 'chat');
  assert.deepEqual(out, {
    content: 'the answer',
    tokenUsage: { prompt: 12, completion: 5, total: 17 },
    model: 'openai/gpt-4o-mini',
    cost: 0.00042
  });
});

test('with a token callback the generator streams, forwarding each token, and returns the final result', async () => {
  const provider = fakeProvider(result({ model: 'openai/gpt-4o-mini-2024-07-18' }));
  const seen: string[] = [];
  const out = await new OpenRouterGenerator(provider).generate({ ...params, onToken: (t) => seen.push(t) });
  assert.equal(provider.calls[0].mode, 'stream');
  assert.deepEqual(seen, ['the ', 'answer']);
  assert.equal(out.content, 'the answer');
  assert.equal(out.model, 'openai/gpt-4o-mini-2024-07-18', 'the model is what the gateway resolved');
});

test('a result without a cost leaves cost undefined instead of zero', async () => {
  const provider = fakeProvider(result({ cost: undefined }));
  const out = await new OpenRouterGenerator(provider).generate(params);
  assert.equal('cost' in out, false);
});

test('fromEnv prefers OpenRouter, falls back to OpenAI, and refuses to start with neither', () => {
  assert.ok(LLMAdapter.fromEnv({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' }) instanceof OpenRouterGenerator);
  assert.ok(LLMAdapter.fromEnv({ OPENAI_API_KEY: 'oa-key' }) instanceof OpenAIGenerator);
  assert.throws(() => LLMAdapter.fromEnv({}), /No model provider is configured/);
});
