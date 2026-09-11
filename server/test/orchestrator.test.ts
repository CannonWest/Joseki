import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatTokenUsage, ChatToolCall } from '@maestroai/shared';
import type { Database } from '../src/db/database';
import type { ChatRequest, ChatStreamEvent } from '../src/providers/openrouter';
import {
  MAX_LOOP_RESULT_CHARS,
  capForStorage,
  executeToolCall,
  runToolLoop,
  type ToolLoopEvent,
  type ToolLoopProvider
} from '../src/tools/orchestrator';
import { ToolRegistry, fail, ok, type ToolContext } from '../src/tools/registry';

interface Turn {
  tokens?: string[];
  content?: string;
  toolCalls?: ChatToolCall[];
  reasoning?: string;
  reasoningDetails?: unknown[];
  usage?: Partial<ChatTokenUsage>;
  cost?: number;
  finishReason?: string;
}

/** A provider that answers each call with the next scripted turn (the last one repeats). */
function scripted(turns: Turn[]) {
  const requests: ChatRequest[] = [];
  const provider: ToolLoopProvider = {
    async *chatStream(request): AsyncGenerator<ChatStreamEvent> {
      requests.push(request);
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
      for (const text of turn.tokens ?? []) yield { type: 'token', text };
      if (turn.reasoning) yield { type: 'reasoning', text: turn.reasoning };
      yield {
        type: 'done',
        result: {
          content: turn.content ?? (turn.tokens ?? []).join(''),
          model: request.model,
          tokenUsage: { prompt: 10, completion: 5, total: 15, ...turn.usage },
          cost: turn.cost ?? 0.001,
          finishReason: turn.finishReason ?? (turn.toolCalls ? 'tool_calls' : 'stop'),
          ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
          ...(turn.reasoningDetails ? { reasoningDetails: turn.reasoningDetails } : {}),
          ...(turn.toolCalls ? { toolCalls: turn.toolCalls } : {})
        }
      };
    }
  };
  return { provider, requests };
}

const call = (id: string, name: string, args: unknown): ChatToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
});

const context: ToolContext = { db: {} as Database, conversationId: 'c1' };

function testRegistry() {
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
      name: 'boom',
      description: 'boom',
      parameters: { type: 'object', properties: {} },
      async execute() {
        throw new Error('kaboom');
      }
    })
    .register({
      name: 'big',
      description: 'big',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return ok('x'.repeat(MAX_LOOP_RESULT_CHARS + 10));
      }
    })
    .register({
      name: 'nuke',
      description: 'nuke',
      parameters: { type: 'object', properties: {} },
      destructive: true,
      async execute() {
        return ok('boom');
      }
    });
}

async function run(
  provider: ToolLoopProvider,
  registry: ToolRegistry,
  options: { signal?: AbortSignal; maxIterations?: number; context?: ToolContext } = {}
) {
  const events: ToolLoopEvent[] = [];
  const loop = runToolLoop(
    provider,
    registry,
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], params: { temperature: 0 } },
    { context: options.context ?? context, signal: options.signal, maxIterations: options.maxIterations }
  );
  for await (const event of loop) events.push(event);
  return events;
}

const types = (events: ToolLoopEvent[]) => events.map((e) => e.type);
const done = (events: ToolLoopEvent[]) => {
  const last = events[events.length - 1];
  assert.equal(last.type, 'done');
  return last as Extract<ToolLoopEvent, { type: 'done' }>;
};

test('with no tools registered the loop is one plain call', async () => {
  const { provider, requests } = scripted([{ tokens: ['Hel', 'lo'] }]);
  const events = await run(provider, new ToolRegistry());

  assert.deepEqual(types(events), ['turn', 'token', 'token', 'done']);
  assert.equal(requests.length, 1);
  assert.equal('tools' in requests[0], false);
  assert.equal('toolChoice' in requests[0], false);
  const final = done(events);
  assert.equal(final.result.content, 'Hello');
  assert.equal(final.iterations, 1);
  assert.equal(final.capped, false);
});

test('a text answer with tools available ends after one call', async () => {
  const { provider, requests } = scripted([{ tokens: ['ok'] }]);
  const events = await run(provider, testRegistry());

  assert.deepEqual(types(events), ['turn', 'token', 'done']);
  assert.deepEqual(requests[0].tools?.map((t) => t.function.name), ['echo', 'boom', 'big']);
  assert.equal(requests[0].toolChoice, 'auto');
  assert.deepEqual(requests[0].params, { temperature: 0 });
});

test('a tool call is executed, fed back, and answered; usage aggregates', async () => {
  const { provider, requests } = scripted([
    { content: 'Let me check.', toolCalls: [call('c1', 'echo', { a: 1 })], usage: { prompt: 10, completion: 5, total: 15, cachedTokens: 3 }, cost: 0.001 },
    { tokens: ['The ', 'answer'], usage: { prompt: 20, completion: 2, total: 22 }, cost: 0.002 }
  ]);
  const events = await run(provider, testRegistry());

  assert.deepEqual(types(events), ['turn', 'tool_turn', 'tool_start', 'tool_end', 'turn', 'token', 'token', 'done']);
  const toolTurn = events[1] as Extract<ToolLoopEvent, { type: 'tool_turn' }>;
  assert.equal(toolTurn.result.content, 'Let me check.');
  assert.deepEqual(toolTurn.result.toolCalls, [call('c1', 'echo', { a: 1 })]);
  const end = events[3] as Extract<ToolLoopEvent, { type: 'tool_end' }>;
  assert.deepEqual(end.outcome, { content: 'echo:{"a":1}', isError: false });
  assert.equal(typeof end.durationMs, 'number');

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Let me check.', tool_calls: [call('c1', 'echo', { a: 1 })] },
    { role: 'tool', tool_call_id: 'c1', content: 'echo:{"a":1}' }
  ]);
  assert.equal(requests[1].toolChoice, 'auto');

  const final = done(events);
  assert.equal(final.result.content, 'The answer');
  assert.equal(final.iterations, 2);
  assert.deepEqual(final.result.tokenUsage, { prompt: 30, completion: 7, total: 37, cachedTokens: 3 });
  assert.equal(final.result.cost, 0.003);
});

test('several calls in one turn run in order', async () => {
  const { provider, requests } = scripted([
    { toolCalls: [call('c1', 'echo', { n: 1 }), call('c2', 'echo', { n: 2 })] },
    { content: 'done' }
  ]);
  const events = await run(provider, testRegistry());

  assert.deepEqual(types(events), ['turn', 'tool_turn', 'tool_start', 'tool_end', 'tool_start', 'tool_end', 'turn', 'done']);
  assert.deepEqual(
    requests[1].messages.slice(2),
    [
      { role: 'tool', tool_call_id: 'c1', content: 'echo:{"n":1}' },
      { role: 'tool', tool_call_id: 'c2', content: 'echo:{"n":2}' }
    ]
  );
});

test('unknown tools, bad arguments, thrown errors and destructive tools all come back as error results', async () => {
  const registry = testRegistry();
  const outcomes = await Promise.all([
    executeToolCall(registry, call('1', 'nope', {}), context),
    executeToolCall(registry, call('2', 'echo', '{not json'), context),
    executeToolCall(registry, call('3', 'echo', '[1,2]'), context),
    executeToolCall(registry, call('4', 'boom', {}), context),
    executeToolCall(registry, call('5', 'nuke', {}), context),
    executeToolCall(registry, call('6', 'echo', ''), context)
  ]);
  assert.deepEqual(outcomes.map((o) => [o.isError, o.errorType]), [
    [true, 'unknown_tool'],
    [true, 'invalid_arguments'],
    [true, 'invalid_arguments'],
    [true, 'execution_error'],
    [true, 'approval_required'],
    [false, undefined]
  ]);
  assert.match(outcomes[3].content, /kaboom/);
  assert.equal(outcomes[5].content, 'echo:{}');
});

test('an error result is fed back so the model can adapt', async () => {
  const { provider, requests } = scripted([{ toolCalls: [call('c1', 'boom', {})] }, { content: 'sorry' }]);
  const events = await run(provider, testRegistry());
  const end = events.find((e) => e.type === 'tool_end') as Extract<ToolLoopEvent, { type: 'tool_end' }>;
  assert.equal(end.outcome.isError, true);
  assert.match((requests[1].messages[2] as { content: string }).content, /Tool "boom" raised: kaboom/);
  assert.equal(done(events).result.content, 'sorry');
});

test('the cap forces a text answer with tool_choice none and the tools kept', async () => {
  const { provider, requests } = scripted([{ toolCalls: [call('c', 'echo', {})] }]);
  const events = await run(provider, testRegistry(), { maxIterations: 2 });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].toolChoice, 'auto');
  assert.equal(requests[1].toolChoice, 'auto');
  assert.equal(requests[2].toolChoice, 'none');
  assert.equal(requests[2].tools?.length, 3);
  assert.equal(events.filter((e) => e.type === 'tool_end').length, 2);
  const final = done(events);
  assert.equal(final.capped, true);
  assert.equal(final.iterations, 3);
  assert.equal(final.result.tokenUsage.total, 45);
});

test('reasoning emitted with tool calls rides back on the assistant message', async () => {
  const structured = scripted([
    { toolCalls: [call('c1', 'echo', {})], reasoning: 'think', reasoningDetails: [{ type: 'reasoning.text', text: 'think' }] },
    { content: 'done' }
  ]);
  await run(structured.provider, testRegistry());
  const withDetails = structured.requests[1].messages[1] as unknown as Record<string, unknown>;
  assert.equal(withDetails.role, 'assistant');
  assert.deepEqual(withDetails.reasoning_details, [{ type: 'reasoning.text', text: 'think' }]);
  assert.equal(withDetails.reasoning, undefined);

  const plain = scripted([{ toolCalls: [call('c1', 'echo', {})], reasoning: 'think' }, { content: 'done' }]);
  await run(plain.provider, testRegistry());
  const withText = plain.requests[1].messages[1] as unknown as Record<string, unknown>;
  assert.equal(withText.reasoning, 'think');
  assert.equal(withText.reasoning_details, undefined);

  const none = scripted([{ toolCalls: [call('c1', 'echo', {})] }, { content: 'done' }]);
  await run(none.provider, testRegistry());
  const bare = none.requests[1].messages[1] as unknown as Record<string, unknown>;
  assert.equal('reasoning' in bare, false);
  assert.equal('reasoning_details' in bare, false);
});

test('oversized results are truncated for the loop and for storage', async () => {
  const { provider, requests } = scripted([{ toolCalls: [call('c1', 'big', {})] }, { content: 'ok' }]);
  await run(provider, testRegistry());
  const fed = (requests[1].messages[2] as { content: string }).content;
  assert.ok(fed.length < MAX_LOOP_RESULT_CHARS + 100);
  assert.match(fed, /\[tool result truncated at 120000 chars\]$/);

  const stored = capForStorage('y'.repeat(20_000));
  assert.ok(stored.length < 16_100);
  assert.match(stored, /\[tool result truncated at 16000 chars\]$/);
  assert.equal(capForStorage('short'), 'short');
});

test('a cancellation during the tool turn ends the loop without another call', async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry().register({
    name: 'stop',
    description: 'stops',
    parameters: { type: 'object', properties: {} },
    async execute() {
      controller.abort();
      return ok('stopped');
    }
  });
  const { provider, requests } = scripted([{ toolCalls: [call('c1', 'stop', {})] }, { content: 'never' }]);
  const events = await run(provider, registry, { signal: controller.signal });

  assert.deepEqual(types(events), ['turn', 'tool_turn', 'tool_start', 'tool_end', 'done']);
  assert.equal(requests.length, 1);
  const final = done(events);
  assert.equal(final.result.finishReason, 'cancelled');
  assert.equal(final.result.content, '');
  assert.equal(final.result.toolCalls, undefined);
});

test('a cancelled provider stream ends the loop', async () => {
  const { provider, requests } = scripted([{ tokens: ['par'], finishReason: 'cancelled' }]);
  const events = await run(provider, testRegistry());
  assert.equal(requests.length, 1);
  assert.equal(done(events).result.finishReason, 'cancelled');
});

test('a tool result that fails is still an error outcome, never a throw', async () => {
  const registry = new ToolRegistry().register({
    name: 'fails',
    description: 'fails',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return fail('nope', 'custom');
    }
  });
  const outcome = await executeToolCall(registry, call('1', 'fails', {}), context);
  assert.deepEqual(outcome, { content: 'nope', isError: true, errorType: 'custom' });
});
