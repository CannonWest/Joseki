import { Server, Socket } from 'socket.io';
import type { ChatSendRequest } from '@maestroai/shared';
import { ChatService } from '../chat/service';

const room = (conversationId: string) => `conversation:${conversationId}`;

/**
 * Chat over socket.io. A turn's events go to the conversation's room, so every
 * socket viewing it — the sender included — sees the same stream.
 */
export function setupChatHandlers(io: Server, chat: ChatService) {
  io.on('connection', (socket: Socket) => {
    socket.on('chat:join', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.join(room(conversationId));
    });

    socket.on('chat:leave', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.leave(room(conversationId));
    });

    socket.on('chat:send', async (data: ChatSendRequest) => {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : '';
      if (!conversationId) {
        socket.emit('chat:error', { conversationId, error: 'conversationId is required' });
        return;
      }

      socket.join(room(conversationId));
      const broadcast = (event: string, payload: unknown) => {
        io.to(room(conversationId)).emit(event, payload);
      };

      try {
        await chat.send(data, {
          onMessage: (message) => broadcast('chat:message', { conversationId, message }),
          onStart: (event) => broadcast('chat:start', event),
          onToken: (event) => broadcast('chat:token', event),
          onReasoning: (event) => broadcast('chat:reasoning', event),
          onToolStart: (event) => broadcast('chat:tool_start', event),
          onToolEnd: (event) => broadcast('chat:tool_end', event),
          onComplete: (event) => broadcast('chat:complete', event),
          onError: (event) => broadcast('chat:error', event)
        });
      } catch (error) {
        // The turn never started (unknown conversation, busy, not configured…)
        socket.emit('chat:error', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    socket.on('chat:cancel', (data: { conversationId: string }) => {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : '';
      if (conversationId) chat.cancel(conversationId);
    });
  });
}
