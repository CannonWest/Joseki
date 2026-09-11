import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatParams,
  ChatReasoningEvent,
  ChatSendRequest,
  ChatStartEvent,
  ChatTokenEvent,
  ChatToolEndEvent,
  ChatToolStartEvent,
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
import { ToolRegistry } from '../tools/registry';
import { capForDisplay, capForStorage, runToolLoop } from '../tools/orchestrator';

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
  /** A message stored during the turn: the user's, an assistant turn that called tools, or a tool result. */
  onMessage?(message: ChatMessage): void;
  /** A provider call is starting; one per loop iteration, each with its own message id. */
  onStart?(event: ChatStartEvent): void;
  onToken?(event: ChatTokenEvent): void;
  onReasoning?(event: ChatReasoningEvent): void;
  onToolStart?(event: ChatToolStartEvent): void;
  onToolEnd?(event: ChatToolEndEvent): void;
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

const NO_TOOLS = new ToolRegistry();

/**
 * Multi-turn chat over the conversation tree. A turn stores the user message
 * under the active leaf (or an explicit parent), runs the tool loop — plain
 * chat when no tools apply — storing each assistant tool turn and tool result
 * as it happens, then stores the final reply and moves the active leaf to it.
 * A reload from the database shows exactly what was streamed.
 */
export class ChatService {
  private readonly inFlight = new Map<string, AbortController>();
  private readonly defaultModel: string;
  private readonly tools: ToolRegistry;

  constructor(
    private readonly db: Database,
    private readonly provider: ChatProvider | null,
    options: { defaultModel?: string; tools?: ToolRegistry } = {}
  ) {
    this.defaultModel = options.defaultModel || DEFAULT_CHAT_MODEL;
    this.tools = options.tools ?? NO_TOOLS;
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
   * Run one turn. Resolves with the stored final assistant message — including
   * when the generation failed (see `message.error`) or was cancelled. Throws a
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

    const conversationId = conversation.id;
    const model = request.model?.trim() || conversation.model;
    const params: ChatParams = { ...conversation.params, ...(request.params ?? {}) };
    const registry = params.tools === false ? NO_TOOLS : this.tools;

    // Store the user's message and make it the active leaf before calling out,
    // so the history is on disk whatever happens next.
    const userMessage: ChatMessage = {
      id: generateId(),
      conversationId,
      parentId,
      role: 'user',
      content,
      createdAt: Date.now()
    };
    this.db.createMessage(userMessage);
    const isFirstMessage = conversation.activeLeafId === null;
    this.db.updateConversation(conversationId, {
      activeLeafId: userMessage.id,
      ...(isFirstMessage && conversation.title === DEFAULT_CONVERSATION_TITLE
        ? { title: deriveTitle(content) }
        : {})
    });
    emit(events.onMessage, userMessage);

    const history = this.db.getActivePath(conversationId);
    const wire = toWireMessages(history, conversation.systemPrompt);

    const controller = new AbortController();
    this.inFlight.set(conversationId, controller);
    const startedAt = Date.now();
    let leafId = userMessage.id;
    let currentId = generateId();
    let turnStartedAt = startedAt;
    let streamed = '';
    let final: ChatResult | undefined;
    let error: string | undefined;

    // Intermediate messages (tool turns, tool results) land in the tree as
    // they happen, each becoming the new leaf.
    const store = (message: ChatMessage) => {
      this.db.createMessage(message);
      this.db.updateConversation(conversationId, { activeLeafId: message.id });
      leafId = message.id;
      emit(events.onMessage, message);
    };

    try {
      const loop = runToolLoop(
        this.provider,
        registry,
        { model, messages: wire, params },
        {
          context: { db: this.db, conversationId, signal: controller.signal },
          signal: controller.signal
        }
      );
      for await (const event of loop) {
        switch (event.type) {
          case 'turn':
            emit(events.onStart, { conversationId, messageId: currentId, parentId: leafId, model });
            break;
          case 'token':
            streamed += event.text;
            emit(events.onToken, { conversationId, messageId: currentId, token: event.text });
            break;
          case 'reasoning':
            emit(events.onReasoning, { conversationId, messageId: currentId, text: event.text });
            break;
          case 'tool_turn':
            store(assistantMessage(currentId, leafId, conversationId, model, event.result, turnStartedAt));
            // Whatever comes next — the next turn, or a stopped reply if the
            // cancel lands while tools run — is a new message.
            currentId = generateId();
            streamed = '';
            turnStartedAt = Date.now();
            break;
          case 'tool_start':
            emit(events.onToolStart, {
              conversationId,
              messageId: currentId,
              callId: event.call.id,
              name: event.call.function.name,
              args: capForDisplay(event.call.function.arguments),
              iteration: event.iteration
            });
            break;
          case 'tool_end': {
            emit(events.onToolEnd, {
              conversationId,
              messageId: currentId,
              callId: event.call.id,
              name: event.call.function.name,
              isError: event.outcome.isError,
              durationMs: event.durationMs,
              iteration: event.iteration
            });
            const toolMessage: ChatMessage = {
              id: generateId(),
              conversationId,
              parentId: leafId,
              role: 'tool',
              content: capForStorage(event.outcome.content),
              createdAt: Date.now(),
              toolCallId: event.call.id,
              latencyMs: event.durationMs
            };
            if (event.outcome.isError) toolMessage.error = event.outcome.errorType ?? 'tool_error';
            store(toolMessage);
            break;
          }
          case 'done':
            final = event.result;
            break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(conversationId);
    }

    // The final reply carries the whole turn's usage, cost and latency.
    const reply = assistantMessage(currentId, leafId, conversationId, model, final, startedAt, streamed);
    if (error) reply.error = error;

    this.db.createMessage(reply);
    this.db.updateConversation(conversationId, { activeLeafId: reply.id });

    if (error) {
      emit(events.onError, { conversationId, messageId: reply.id, error, message: reply });
    } else {
      emit(events.onComplete, { conversationId, message: reply });
    }
    return reply;
  }

  /** Stop the in-flight generation; what streamed so far is kept. */
  cancel(conversationId: string): boolean {
    const controller = this.inFlight.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

function assistantMessage(
  id: string,
  parentId: string,
  conversationId: string,
  model: string,
  result: ChatResult | undefined,
  startedAt: number,
  streamed = ''
): ChatMessage {
  const message: ChatMessage = {
    id,
    conversationId,
    parentId,
    role: 'assistant',
    content: result?.content ?? streamed,
    createdAt: Date.now(),
    model: result?.model ?? model,
    latencyMs: Date.now() - startedAt
  };
  if (result) {
    message.tokenUsage = result.tokenUsage;
    if (result.cost !== undefined) message.cost = result.cost;
    if (result.finishReason) message.finishReason = result.finishReason;
    if (result.reasoning) message.reasoning = result.reasoning;
    if (result.reasoningDetails?.length) message.reasoningDetails = result.reasoningDetails;
    if (result.toolCalls?.length) message.toolCalls = result.toolCalls;
  }
  return message;
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
