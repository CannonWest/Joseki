import { memo } from 'react';
import type { ChatMessage, ChatModel } from '@maestroai/shared';
import { useChatStore, type StreamingReply } from '../../stores/chatStore';
import { Markdown } from './Markdown';
import { estimateCost, formatCost, formatLatency, formatTokens, shortModel } from './format';

/**
 * The catalog record behind a reply's resolved model — only for a reply the
 * gateway gave no cost for, so its meta line can carry an estimate.
 */
export function useReplyModel(message: ChatMessage): ChatModel | undefined {
  return useChatStore((state) =>
    message.role === 'assistant' && message.cost === undefined && message.model
      ? state.catalog.find((model) => model.id === message.model)
      : undefined
  );
}

export function Reasoning({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <details className="mb-2 text-xs">
      <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-300">
        {live ? 'Thinking…' : 'Reasoning'}
      </summary>
      <div className="mt-1 pl-2 border-l-2 border-slate-700 text-slate-400 whitespace-pre-wrap">{text}</div>
    </details>
  );
}

export function Meta({ items }: { items: Array<string | null | undefined> }) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return <div className="mt-2 text-xs text-slate-500">{shown.join(' · ')}</div>;
}

/**
 * The meta line of an assistant message: model · tokens · cost · latency ·
 * stopped. When the gateway reported no cost, `model` (the catalog record)
 * prices the usage instead, marked as an estimate; a stopped reply has no
 * usage, so it shows no figure at all.
 */
export function assistantMeta(message: ChatMessage, model?: ChatModel): Array<string | null | undefined> {
  const estimate = message.cost === undefined ? estimateCost(message.tokenUsage, model) : undefined;
  const cost = estimate === undefined ? formatCost(message.cost) : `~${formatCost(estimate)} est.`;
  return [
    message.model ? shortModel(message.model) : null,
    message.provider ? `via ${message.provider}` : null,
    formatTokens(message.tokenUsage?.total, message.tokenUsage?.reasoningTokens),
    cost,
    formatLatency(message.latencyMs),
    message.finishReason === 'cancelled' ? 'stopped' : null
  ];
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const model = useReplyModel(message);
  switch (message.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] bg-blue-600/20 border border-blue-500/30 rounded-lg px-4 py-2 text-sm text-slate-100 whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      );
    case 'tool':
      // A tool result whose call is not in view (normally it renders inside its ToolTurnCard)
      return (
        <div
          className={`text-xs font-mono rounded px-3 py-2 whitespace-pre-wrap break-words border ${
            message.error ? 'bg-red-950/30 border-red-900 text-red-200' : 'bg-slate-900 border-slate-800 text-slate-400'
          }`}
        >
          {message.content}
        </div>
      );
    case 'system':
      return <div className="text-xs text-slate-500 text-center italic">{message.content}</div>;
    default: {
      const failed = Boolean(message.error);
      return (
        <div className="flex justify-start">
          <div
            className={`max-w-[85%] min-w-0 rounded-lg px-4 py-3 border ${
              failed ? 'bg-red-950/30 border-red-800' : 'bg-slate-900 border-slate-800'
            }`}
          >
            {message.reasoning && <Reasoning text={message.reasoning} />}
            {message.content ? (
              <Markdown text={message.content} />
            ) : (
              !failed && <span className="text-sm text-slate-500 italic">Empty reply</span>
            )}
            {failed && <div className="mt-2 text-sm text-red-300">{message.error}</div>}
            <Meta items={assistantMeta(message, model)} />
          </div>
        </div>
      );
    }
  }
});

export function StreamingBubble({ reply }: { reply: StreamingReply }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] min-w-0 rounded-lg px-4 py-3 border bg-slate-900 border-slate-800">
        {reply.reasoning && <Reasoning text={reply.reasoning} live />}
        {reply.content ? (
          <Markdown text={reply.content} />
        ) : (
          <span className="text-sm text-slate-500 animate-pulse">…</span>
        )}
        <div className="mt-2 text-xs text-slate-500 flex items-center gap-2">
          <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse" />
          {reply.model ? shortModel(reply.model) : 'streaming'}
        </div>
      </div>
    </div>
  );
}
