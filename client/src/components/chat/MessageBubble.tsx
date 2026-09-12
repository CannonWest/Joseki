import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

/** Where a message sits among its siblings — the alternatives a retry or an edit made. */
export interface BranchNav {
  index: number;
  count: number;
  onPrev?: () => void;
  onNext?: () => void;
}

const navButton = 'px-1 rounded hover:text-slate-200 disabled:opacity-40 disabled:hover:text-slate-500';
const actionButton = 'text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40 disabled:hover:text-slate-500';

export function BranchSwitch({ nav, disabled }: { nav: BranchNav; disabled: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="Other versions of this message">
      <button
        type="button"
        onClick={nav.onPrev}
        disabled={disabled || !nav.onPrev}
        className={navButton}
        aria-label="Previous version"
      >
        ‹
      </button>
      <span className="tabular-nums">
        {nav.index + 1}/{nav.count}
      </span>
      <button
        type="button"
        onClick={nav.onNext}
        disabled={disabled || !nav.onNext}
        className={navButton}
        aria-label="Next version"
      >
        ›
      </button>
    </span>
  );
}

/** The retry / branch row under an assistant reply. */
export function ReplyActions({
  branch,
  busy,
  onRetry
}: {
  branch?: BranchNav;
  busy: boolean;
  onRetry?: () => void;
}) {
  if (!branch && !onRetry) return null;
  return (
    <div className="mt-1.5 flex items-center gap-3">
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className={actionButton}
          title="Generate this reply again — the current one stays as another version"
        >
          Retry
        </button>
      )}
      {branch && <BranchSwitch nav={branch} disabled={busy} />}
    </div>
  );
}

/** An inline editor for a user message; sending makes a new branch. */
function UserEditor({
  initial,
  onSend,
  onCancel
}: {
  initial: string;
  onSend: (content: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Unchanged text is a cancel, not a pointless new branch.
  const submit = () => {
    const content = text.trim();
    if (content && content !== initial.trim()) onSend(content);
    else onCancel();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex justify-end">
      <div className="w-[80%] bg-blue-600/10 border border-blue-500/40 rounded-lg p-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          aria-label="Edit message"
          className="w-full resize-y bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500">Enter to send as a new version · Esc to cancel</span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded"
            >
              Send
            </button>
          </span>
        </div>
      </div>
    </div>
  );
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

interface MessageBubbleProps {
  message: ChatMessage;
  /** Set when the message has siblings — retries or edits at this point of the tree. */
  branch?: BranchNav;
  /** A reply is in flight: retry, edit and branch switching wait. */
  busy?: boolean;
  /** Assistant replies: generate again from the user message that led here. */
  onRetry?: () => void;
  /** User messages: send an edited version. */
  onEdit?: (content: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  branch,
  busy = false,
  onRetry,
  onEdit
}: MessageBubbleProps) {
  const model = useReplyModel(message);
  const [editing, setEditing] = useState(false);
  switch (message.role) {
    case 'user':
      if (editing && onEdit) {
        return (
          <UserEditor
            initial={message.content}
            onSend={(content) => {
              setEditing(false);
              onEdit(content);
            }}
            onCancel={() => setEditing(false)}
          />
        );
      }
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[80%] bg-blue-600/20 border border-blue-500/30 rounded-lg px-4 py-2 text-sm text-slate-100 whitespace-pre-wrap break-words">
            {message.content}
          </div>
          {(branch || onEdit) && (
            <div className="flex items-center gap-3 pr-1">
              {branch && <BranchSwitch nav={branch} disabled={busy} />}
              {onEdit && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className={actionButton}
                  title="Send an edited version — the current one stays as another version"
                >
                  Edit
                </button>
              )}
            </div>
          )}
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
            <ReplyActions branch={branch} busy={busy} onRetry={onRetry} />
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
