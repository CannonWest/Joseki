import type { ChatParams, ChatTokenUsage, ChatToolCall } from '@maestroai/shared';
import type {
  AssistantWireMessage,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  WireMessage
} from '../providers/openrouter';
import type { ToolContext, ToolOutcome, ToolRegistry } from './registry';
import { fail } from './registry';

/**
 * The tool loop: call the model with the registry's tools, execute whatever it
 * asks for, feed the results back, repeat until it answers in text or the cap
 * forces it to. Pure — it yields what happened and never touches storage; the
 * chat service persists messages and emits socket events from the stream.
 */

/** Provider round-trips per turn before synthesis is forced. */
export const MAX_TOOL_ITERATIONS = 8;
/** What one result may feed back into the loop (protects the context window). */
export const MAX_LOOP_RESULT_CHARS = 120_000;
/** What one result keeps when stored on the conversation. */
export const MAX_STORED_RESULT_CHARS = 16_000;
/** Arguments shown on live tool-status events (the stored call keeps them whole). */
export const MAX_DISPLAYED_ARGS_CHARS = 2_000;

export interface ToolLoopProvider {
  chatStream(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncGenerator<ChatStreamEvent>;
}

export interface ToolLoopRequest {
  model: string;
  messages: WireMessage[];
  params?: ChatParams;
}

export interface ToolLoopOptions {
  context: ToolContext;
  signal?: AbortSignal;
  maxIterations?: number;
}

export type ToolLoopEvent =
  /** A provider call is starting. */
  | { type: 'turn'; iteration: number }
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  /** The model answered with tool calls; `result` is that assistant turn. */
  | { type: 'tool_turn'; iteration: number; result: ChatResult }
  | { type: 'tool_start'; iteration: number; call: ChatToolCall }
  | { type: 'tool_end'; iteration: number; call: ChatToolCall; outcome: ToolOutcome; durationMs: number }
  /** The final text turn. `result.tokenUsage` and `result.cost` are the whole turn's. */
  | { type: 'done'; iterations: number; capped: boolean; result: ChatResult };

export async function* runToolLoop(
  provider: ToolLoopProvider,
  registry: ToolRegistry,
  request: ToolLoopRequest,
  options: ToolLoopOptions
): AsyncGenerator<ToolLoopEvent> {
  const tools = registry.assemble();
  const maxIterations = options.maxIterations ?? MAX_TOOL_ITERATIONS;
  const working: WireMessage[] = [...request.messages];
  const usage = new UsageTally();

  for (let iteration = 1; ; iteration++) {
    // One call past the cap is allowed, with tool_choice pinned to "none":
    // the tools param stays (some upstreams reject tool-call history without
    // it) but the model has to answer in text.
    const forced = iteration > maxIterations;
    yield { type: 'turn', iteration };

    const call: ChatRequest = { model: request.model, messages: working, params: request.params };
    if (tools.length) {
      call.tools = tools;
      call.toolChoice = forced ? 'none' : 'auto';
    }

    let result: ChatResult | undefined;
    for await (const event of provider.chatStream(call, { signal: options.signal })) {
      if (event.type === 'done') result = event.result;
      else yield event;
    }
    if (!result) throw new Error('The provider stream ended without a result');
    usage.add(result);

    const calls = result.toolCalls ?? [];
    const cancelled = result.finishReason === 'cancelled' || options.signal?.aborted === true;
    if (calls.length === 0 || forced || cancelled) {
      yield { type: 'done', iterations: iteration, capped: forced, result: usage.finalize(result) };
      return;
    }

    yield { type: 'tool_turn', iteration, result };
    working.push(assistantWireMessage(result));

    for (const toolCall of calls) {
      yield { type: 'tool_start', iteration, call: toolCall };
      const startedAt = Date.now();
      const outcome = await executeToolCall(registry, toolCall, options.context);
      const durationMs = Date.now() - startedAt;
      yield { type: 'tool_end', iteration, call: toolCall, outcome, durationMs };
      working.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: capForLoop(outcome.content)
      });
    }

    if (options.signal?.aborted) {
      // Stopped while tools were running: nothing more goes to the model.
      yield {
        type: 'done',
        iterations: iteration,
        capped: false,
        result: usage.finalize({ ...result, content: '', toolCalls: undefined, finishReason: 'cancelled' })
      };
      return;
    }
  }
}

/** Run one call from the model. Never throws — every failure is an error result. */
export async function executeToolCall(
  registry: ToolRegistry,
  call: ChatToolCall,
  context: ToolContext
): Promise<ToolOutcome> {
  const name = call.function?.name ?? '';
  const tool = registry.get(name);
  if (!tool) return fail(`Unknown tool "${name}".`, 'unknown_tool');
  if (tool.destructive) return fail(`Tool "${name}" needs an approval gate and is not available here.`, 'approval_required');

  let args: unknown;
  const raw = call.function.arguments;
  try {
    args = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(`Invalid tool arguments (not JSON): ${raw.slice(0, 200)}`, 'invalid_arguments');
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return fail(`Tool arguments must be a JSON object, got ${Array.isArray(args) ? 'array' : typeof args}.`, 'invalid_arguments');
  }

  try {
    return await tool.execute(args as Record<string, unknown>, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Tool "${name}" raised: ${message}`, 'execution_error');
  }
}

/**
 * The assistant turn that asked for tools, as history for the next call.
 * A thinking model must see its own reasoning again next to the calls
 * (some upstreams reject the history without it): OpenRouter takes the
 * structured `reasoning_details`, or the plain `reasoning` text.
 */
export function assistantWireMessage(result: ChatResult): WireMessage {
  const message: AssistantWireMessage = {
    role: 'assistant',
    content: result.content,
    tool_calls: result.toolCalls
  };
  if (result.reasoningDetails?.length) message.reasoning_details = result.reasoningDetails;
  else if (result.reasoning) message.reasoning = result.reasoning;
  return message;
}

export function capForLoop(content: string): string {
  if (content.length <= MAX_LOOP_RESULT_CHARS) return content;
  return `${content.slice(0, MAX_LOOP_RESULT_CHARS)}\n\n[tool result truncated at ${MAX_LOOP_RESULT_CHARS} chars]`;
}

export function capForStorage(content: string): string {
  if (content.length <= MAX_STORED_RESULT_CHARS) return content;
  return `${content.slice(0, MAX_STORED_RESULT_CHARS)}\n\n[tool result truncated at ${MAX_STORED_RESULT_CHARS} chars]`;
}

export function capForDisplay(args: string): string {
  return args.length <= MAX_DISPLAYED_ARGS_CHARS ? args : `${args.slice(0, MAX_DISPLAYED_ARGS_CHARS)}…`;
}

/** Token usage and cost summed across every provider call of the turn. */
class UsageTally {
  private readonly usage: ChatTokenUsage = { prompt: 0, completion: 0, total: 0 };
  private cost = 0;
  private costSeen = false;
  private byok = false;

  add(result: ChatResult): void {
    const u = result.tokenUsage;
    this.usage.prompt += u.prompt;
    this.usage.completion += u.completion;
    this.usage.total += u.total;
    for (const key of ['cachedTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
      if (u[key]) this.usage[key] = (this.usage[key] ?? 0) + u[key]!;
    }
    if (u.byok) this.byok = true;
    if (result.cost !== undefined) {
      this.cost += result.cost;
      this.costSeen = true;
    }
  }

  finalize(result: ChatResult): ChatResult {
    const tokenUsage: ChatTokenUsage = { ...this.usage };
    if (this.byok) tokenUsage.byok = true;
    return {
      ...result,
      tokenUsage,
      cost: this.costSeen ? Math.round(this.cost * 1e10) / 1e10 : undefined
    };
  }
}
