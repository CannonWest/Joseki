import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatParams,
  ChatReasoningEvent,
  ChatSendRequest,
  ChatStartEvent,
  ChatTokenEvent,
  Conversation
} from '@maestroai/shared';
import { generateId } from '@maestroai/shared';
import { Database } from '../db/database';
import {
  DEFAULT_CHAT_MODEL,
  toWireMessages,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent
} from '../providers/openrouter';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
export const DEFAULT_CHAT_PARAMS: ChatParams = { temperature: 0.7, maxTokens: 4096 };
const TITLE_MAX_LENGTH = 60;

export type ChatErrorCode = 'not_configured' | 'not_found' | 'busy' | 'invalid';

/** A request that cannot start — as opposed to a generation that failed. */
export class ChatError extends Error {
  constructor(message: string, readonly code: ChatErrorCode) {
    super(message);
    this.name = 'ChatError';
  }
}

/** The slice of the provider the chat service depends on. */
export interface ChatProvider {
  chatStream(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncGenerator<ChatStreamEvent>;
}

export interface ChatEvents {
  /** The user's message, once stored. */
  onUserMessage?(message: ChatMessage): void;
  onStart?(event: ChatStartEvent): void;
  onToken?(event: ChatTokenEvent): void;
  onReasoning?(event: ChatReasoningEvent): void;
  onComplete?(event: ChatCompleteEvent): void;
  /** The generation failed; the stored assistant message carries the error. */
  onError?(event: ChatErrorEvent): void;
}

export interface CreateConversationInput {
  title?: string;
  model?: string;
  systemPrompt?: string;
  params?: ChatParams;
}

/**
 * Multi-turn chat over the conversation tree. A turn stores the user message
 * under the active leaf (or an explicit parent), streams the reply from the
 * provider, stores the assistant message and moves the active leaf to it —
 * so a reload from the database shows exactly what was streamed.
 */
export class ChatService {
  private readonly inFlight = new Map<string, AbortController>();
  private readonly defaultModel: string;

  constructor(
    private readonly db: Database,
    private readonly provider: ChatProvider | null,
    options: { defaultModel?: string } = {}
  ) {
    this.defaultModel = options.defaultModel || DEFAULT_CHAT_MODEL;
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  isGenerating(conversationId: string): boolean {
    return this.inFlight.has(conversationId);
  }

  createConversation(input: CreateConversationInput = {}): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: generateId(),
      title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
      model: input.model?.trim() || this.defaultModel,
      systemPrompt: input.systemPrompt?.trim() ? input.systemPrompt : null,
      params: { ...DEFAULT_CHAT_PARAMS, ...(input.params ?? {}) },
      activeLeafId: null,
      createdAt: now,
      updatedAt: now
    };
    this.db.createConversation(conversation);
    return conversation;
  }

  /**
   * Run one turn. Resolves with the stored assistant message — including when
   * the generation failed (see `message.error`) or was cancelled. Throws a
   * ChatError only when the turn cannot start.
   */
  async send(request: ChatSendRequest, events: ChatEvents = {}): Promise<ChatMessage> {
    if (!this.provider) {
      throw new ChatError('OpenRouter is not configured — set OPENROUTER_API_KEY', 'not_configured');
    }

    const conversation = this.db.getConversation(request.conversationId);
    if (!conversation) {
      throw new ChatError('Conversation not found', 'not_found');
    }
    if (this.inFlight.has(conversation.id)) {
      throw new ChatError('A reply is already being generated for this conversation', 'busy');
    }

    const content = typeof request.content === 'string' ? request.content : '';
    if (!content.trim()) {
      throw new ChatError('Message content is required', 'invalid');
    }

    let parentId = conversation.activeLeafId;
    if (request.parentId) {
      const parent = this.db.getMessage(request.parentId);
      if (!parent || parent.conversationId !== conversation.id) {
        throw new ChatError('parentId does not belong to this conversation', 'invalid');
      }
      parentId = parent.id;
    }

    const model = request.model?.trim() || conversation.model;
    const params: ChatParams = { ...conversation.params, ...(request.params ?? {}) };

    // Store the user's message and make it the active leaf before calling out,
    // so the history is on disk whatever happens next.
    const userMessage: ChatMessage = {
      id: generateId(),
      conversationId: conversation.id,
      parentId,
      role: 'user',
      content,
      createdAt: Date.now()
    };
    this.db.createMessage(userMessage);
    const isFirstMessage = conversation.activeLeafId === null;
    this.db.updateConversation(conversation.id, {
      activeLeafId: userMessage.id,
      ...(isFirstMessage && conversation.title === DEFAULT_CONVERSATION_TITLE
        ? { title: deriveTitle(content) }
        : {})
    });
    emit(events.onUserMessage, userMessage);

    const history = this.db.getActivePath(conversation.id);
    const wire = toWireMessages(history, conversation.systemPrompt);

    const assistantId = generateId();
    emit(events.onStart, {
      conversationId: conversation.id,
      messageId: assistantId,
      parentId: userMessage.id,
      model
    });

    const controller = new AbortController();
    this.inFlight.set(conversation.id, controller);
    const startedAt = Date.now();
    let streamed = '';
    let result: ChatResult | undefined;
    let error: string | undefined;

    try {
      const stream = this.provider.chatStream(
        { model, messages: wire, params },
        { signal: controller.signal }
      );
      for await (const event of stream) {
        if (event.type === 'token') {
          streamed += event.text;
          emit(events.onToken, { conversationId: conversation.id, messageId: assistantId, token: event.text });
        } else if (event.type === 'reasoning') {
          emit(events.onReasoning, { conversationId: conversation.id, messageId: assistantId, text: event.text });
        } else {
          result = event.result;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(conversation.id);
    }

    const assistantMessage: ChatMessage = {
      id: assistantId,
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: 'assistant',
      content: result?.content ?? streamed,
      createdAt: Date.now(),
      model: result?.model ?? model,
      latencyMs: Date.now() - startedAt
    };
    if (result) {
      assistantMessage.tokenUsage = result.tokenUsage;
      if (result.cost !== undefined) assistantMessage.cost = result.cost;
      if (result.finishReason) assistantMessage.finishReason = result.finishReason;
      if (result.reasoning) assistantMessage.reasoning = result.reasoning;
      if (result.toolCalls?.length) assistantMessage.toolCalls = result.toolCalls;
    }
    if (error) assistantMessage.error = error;

    this.db.createMessage(assistantMessage);
    this.db.updateConversation(conversation.id, { activeLeafId: assistantMessage.id });

    if (error) {
      emit(events.onError, {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        error,
        message: assistantMessage
      });
    } else {
      emit(events.onComplete, { conversationId: conversation.id, message: assistantMessage });
    }
    return assistantMessage;
  }

  /** Stop the in-flight generation; what streamed so far is kept. */
  cancel(conversationId: string): boolean {
    const controller = this.inFlight.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

function deriveTitle(content: string): string {
  const line = content.trim().split(/\r?\n/)[0].trim();
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 1)}…` : line;
}

// Event delivery must never break a turn: a listener that throws is logged
// and the generation carries on.
function emit<T>(listener: ((event: T) => void) | undefined, event: T): void {
  if (!listener) return;
  try {
    listener(event);
  } catch (error) {
    console.warn('Chat event listener failed:', error);
  }
}
