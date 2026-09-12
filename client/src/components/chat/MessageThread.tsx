import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@joseki/shared';
import { latestLeafUnder, siblingsOf } from '@joseki/shared';
import type { StreamingReply, ToolActivity } from '../../stores/chatStore';
import { MessageBubble, StreamingBubble, type BranchNav } from './MessageBubble';
import { ToolTurnCard } from './ToolTurnCard';

interface MessageThreadProps {
  /** The branch in view, oldest first. */
  messages: ChatMessage[];
  /** Every message of the conversation — the whole tree, for the branch counters. */
  tree: ChatMessage[];
  streaming: StreamingReply | null;
  generating: boolean;
  toolActivity: ToolActivity[];
  /** A reply is in flight: retry, edit and branch switching wait. */
  busy: boolean;
  /** Generate a reply again from the user message that led to `reply` — a new branch. */
  onRetry: (reply: ChatMessage) => void;
  /** Send an edited version of a user message — a new branch. */
  onEdit: (message: ChatMessage, content: string) => void;
  /** Show another branch: its leaf becomes the conversation's active leaf. */
  onSelectBranch: (leafId: string) => void;
}

export function MessageThread({
  messages,
  tree,
  streaming,
  generating,
  toolActivity,
  busy,
  onRetry,
  onEdit,
  onSelectBranch
}: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep following the bottom unless the reader scrolled up to look at something.
  const followRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    followRef.current = true;
  }, [messages[0]?.conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming?.content.length, streaming?.reasoning.length, generating, toolActivity]);

  // Tool results render inside the assistant turn that called them.
  const results = new Map<string, ChatMessage>();
  const claimed = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) results.set(message.toolCallId, message);
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) claimed.add(call.id);
  }
  const shown = messages.filter(
    (message) => !(message.role === 'tool' && message.toolCallId && claimed.has(message.toolCallId))
  );

  // A message with siblings (retries, edits) gets a counter; choosing a
  // sibling shows that branch down to its newest leaf.
  const branchFor = (message: ChatMessage): BranchNav | undefined => {
    const siblings = siblingsOf(tree, message);
    if (siblings.length < 2) return undefined;
    const index = siblings.findIndex((sibling) => sibling.id === message.id);
    const go = (offset: number) => {
      const target = siblings[index + offset];
      if (target) onSelectBranch(latestLeafUnder(tree, target.id));
    };
    return {
      index,
      count: siblings.length,
      onPrev: index > 0 ? () => go(-1) : undefined,
      onNext: index < siblings.length - 1 ? () => go(1) : undefined
    };
  };

  const empty = messages.length === 0 && !streaming && !generating;
  const runningTools = toolActivity.some((activity) => activity.status === 'running');

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {empty && (
        <div className="h-full flex items-center justify-center text-sm text-slate-500">
          Send a message to start the conversation
        </div>
      )}
      {shown.map((message) =>
        message.role === 'assistant' && message.toolCalls?.length ? (
          <ToolTurnCard
            key={message.id}
            message={message}
            results={results}
            activity={toolActivity}
            branch={branchFor(message)}
            busy={busy}
            onRetry={() => onRetry(message)}
          />
        ) : (
          <MessageBubble
            key={message.id}
            message={message}
            branch={branchFor(message)}
            busy={busy}
            onRetry={message.role === 'assistant' ? () => onRetry(message) : undefined}
            onEdit={message.role === 'user' ? (content) => onEdit(message, content) : undefined}
          />
        )
      )}
      {streaming && <StreamingBubble reply={streaming} />}
      {generating && !streaming && (
        <div className="text-sm text-slate-500 animate-pulse">
          {runningTools ? 'Running tools…' : 'Waiting for the model…'}
        </div>
      )}
    </div>
  );
}
