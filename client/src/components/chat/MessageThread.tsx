import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@maestroai/shared';
import type { StreamingReply } from '../../stores/chatStore';
import { MessageBubble, StreamingBubble } from './MessageBubble';

interface MessageThreadProps {
  /** The branch in view, oldest first. */
  messages: ChatMessage[];
  streaming: StreamingReply | null;
  generating: boolean;
}

export function MessageThread({ messages, streaming, generating }: MessageThreadProps) {
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
  }, [messages.length, streaming?.content.length, streaming?.reasoning.length, generating]);

  const empty = messages.length === 0 && !streaming && !generating;

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {empty && (
        <div className="h-full flex items-center justify-center text-sm text-slate-500">
          Send a message to start the conversation
        </div>
      )}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {streaming && <StreamingBubble reply={streaming} />}
      {generating && !streaming && (
        <div className="text-sm text-slate-500 animate-pulse">Waiting for the model…</div>
      )}
    </div>
  );
}
