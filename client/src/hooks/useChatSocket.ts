import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ChatSendRequest } from '@maestroai/shared';
import { useChatStore } from '../stores/chatStore';

/**
 * The chat socket: feeds `chat:*` events into the chat store and follows the
 * open conversation's room. One connection per mounted chat view.
 */
export function useChatSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const currentId = useChatStore((state) => state.currentId);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_WS_URL || 'ws://localhost:3001');
    socketRef.current = socket;
    const store = () => useChatStore.getState();
    let connectedBefore = false;

    socket.on('connect', () => {
      setIsConnected(true);
      const openId = store().currentId;
      if (openId) {
        socket.emit('chat:join', openId);
        // Events missed while disconnected are in the database by now.
        if (connectedBefore) void store().openConversation(openId);
      }
      connectedBefore = true;
    });
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('chat:message', (event) => store().handleMessage(event));
    socket.on('chat:start', (event) => store().handleStart(event));
    socket.on('chat:token', (event) => store().handleToken(event));
    socket.on('chat:reasoning', (event) => store().handleReasoning(event));
    socket.on('chat:tool_start', (event) => store().handleToolStart(event));
    socket.on('chat:tool_end', (event) => store().handleToolEnd(event));
    socket.on('chat:complete', (event) => store().handleComplete(event));
    socket.on('chat:error', (event) => store().handleError(event));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Follow the open conversation's room
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !currentId) return;
    if (socket.connected) socket.emit('chat:join', currentId);
    return () => {
      if (socket.connected) socket.emit('chat:leave', currentId);
    };
  }, [currentId]);

  const send = useCallback((request: ChatSendRequest) => {
    socketRef.current?.emit('chat:send', request);
  }, []);

  const cancel = useCallback((conversationId: string) => {
    socketRef.current?.emit('chat:cancel', { conversationId });
  }, []);

  return { isConnected, send, cancel };
}
