import { memo } from 'react';
import type { ChatMessage } from '@maestroai/shared';
import type { StreamingReply } from '../../stores/chatStore';
import { Markdown } from './Markdown';
import { formatCost, formatLatency, formatTokens, shortModel } from './format';

function Reasoning({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <details className="mb-2 text-xs">
      <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-300">
        {live ? 'Thinking…' : 'Reasoning'}
      </summary>
      <div className="mt-1 pl-2 border-l-2 border-slate-700 text-slate-400 whitespace-pre-wrap">{text}</div>
    </details>
  );
}

function Meta({ items }: { items: Array<string | null | undefined> }) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return <div className="mt-2 text-xs text-slate-500">{shown.join(' · ')}</div>;
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
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
      return (
        <div className="text-xs font-mono bg-slate-900 border border-slate-800 rounded px-3 py-2 text-slate-400 whitespace-pre-wrap break-words">
          {message.content}
        </div>
      );
    case 'system':
      return <div className="text-xs text-slate-500 text-center italic">{message.content}</div>;
    default: {
      const failed = Boolean(message.error);
      const cancelled = message.finishReason === 'cancelled';
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
            <Meta
              items={[
                message.model ? shortModel(message.model) : null,
                formatTokens(message.tokenUsage?.total),
                formatCost(message.cost),
                formatLatency(message.latencyMs),
                cancelled ? 'stopped' : null
              ]}
            />
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
