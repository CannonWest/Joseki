import type { ChatToolCall } from '@maestroai/shared';

/**
 * One streaming fragment of a tool call, as OpenAI-compatible providers emit
 * it on `delta.tool_calls`. `id` and `function.name` normally arrive whole on
 * the first fragment; `function.arguments` accumulates as string pieces.
 */
export interface ToolCallDelta {
  index?: number;
  id?: string | null;
  type?: string | null;
  function?: {
    name?: string | null;
    arguments?: string | null;
  } | null;
}

/**
 * Fold one chunk's `delta.tool_calls` into `acc`, keyed by the delta's index.
 * Shared by the streaming path of every OpenAI-compatible provider.
 */
export function accumulateToolCallDeltas(
  acc: Map<number, ChatToolCall>,
  deltas: ToolCallDelta[] | null | undefined
): void {
  for (const delta of deltas ?? []) {
    const index = delta.index ?? 0;
    let slot = acc.get(index);
    if (!slot) {
      slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
      acc.set(index, slot);
    }
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.function.name += delta.function.name;
    if (delta.function?.arguments) slot.function.arguments += delta.function.arguments;
  }
}

/** Accumulated fragments → complete tool calls, in index order. */
export function finalizeToolCallDeltas(acc: Map<number, ChatToolCall>): ChatToolCall[] {
  return [...acc.keys()].sort((a, b) => a - b).map((index) => acc.get(index)!);
}
