import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@maestroai/shared';
import type { StreamingReply, ToolActivity } from '../../stores/chatStore';
import { MessageBubble, StreamingBubble } from './MessageBubble';
import { ToolTurnCard } from './ToolTurnCard';

interface MessageThreadProps {
  /** The branch in view, oldest first. */
  messages: ChatMessage[];
  streaming: StreamingReply | null;
  generating: boolean;
  toolActivity: ToolActivity[];
}

export function MessageThread({ messages, streaming, generating, toolActivity }: MessageThreadProps) {
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
          <ToolTurnCard key={message.id} message={message} results={results} activity={toolActivity} />
        ) : (
          <MessageBubble key={message.id} message={message} />
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
