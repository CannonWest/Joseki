import { create } from 'zustand';
import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatMessageEvent,
  ChatModel,
  ChatParams,
  ChatReasoningEvent,
  ChatStartEvent,
  ChatTokenEvent,
  Conversation,
  ConversationDetail
} from '@maestroai/shared';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
const TITLE_MAX_LENGTH = 60;

/** The assistant reply streaming in right now, before it is stored. */
export interface StreamingReply {
  messageId: string;
  parentId: string;
  model: string;
  content: string;
  reasoning: string;
}

export interface ConversationPatch {
  title?: string;
  model?: string;
  systemPrompt?: string | null;
  params?: ChatParams;
  activeLeafId?: string | null;
}

export interface CreateConversationInput {
  title?: string;
  model?: string;
  systemPrompt?: string;
  params?: ChatParams;
}

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ChatState {
  /** Whether the server has an OpenRouter key; null until /health answers. */
  configured: boolean | null;
  defaultModel: string | null;
  conversations: Conversation[];
  currentId: string | null;
  /** Every message of the open conversation — the whole tree. */
  messages: ChatMessage[];
  /** The server is generating a reply for the open conversation. */
  generating: boolean;
  streaming: StreamingReply | null;
  catalog: ChatModel[];
  catalogStatus: CatalogStatus;
  error: string | null;

  checkHealth: () => Promise<void>;
  loadConversations: () => Promise<void>;
  createConversation: (input?: CreateConversationInput) => Promise<Conversation | undefined>;
  openConversation: (id: string) => Promise<void>;
  closeConversation: () => void;
  updateConversation: (id: string, patch: ConversationPatch) => Promise<Conversation | undefined>;
  deleteConversation: (id: string) => Promise<boolean>;
  loadCatalog: (force?: boolean) => Promise<void>;
  clearError: () => void;

  // Socket events for the open conversation
  handleUserMessage: (event: ChatMessageEvent) => void;
  handleStart: (event: ChatStartEvent) => void;
  handleToken: (event: ChatTokenEvent) => void;
  handleReasoning: (event: ChatReasoningEvent) => void;
  handleComplete: (event: ChatCompleteEvent) => void;
  handleError: (event: ChatErrorEvent) => void;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.error || fallback;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

async function request<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await readError(response, fallback));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function byRecentActivity(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt;
}

/** Replace (or add) a conversation and keep the list ordered by recent activity. */
function upsert(list: Conversation[], conversation: Conversation): Conversation[] {
  return [...list.filter((c) => c.id !== conversation.id), conversation].sort(byRecentActivity);
}

function patchConversation(list: Conversation[], id: string, patch: Partial<Conversation>): Conversation[] {
  return list.map((c) => (c.id === id ? { ...c, ...patch } : c)).sort(byRecentActivity);
}

// Mirrors the server's auto-title so the list reads right before the reply lands.
function deriveTitle(content: string): string {
  const line = content.trim().split(/\r?\n/)[0].trim();
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 1)}…` : line;
}

const idle = { streaming: null, generating: false } as const;

function freshReply(messageId: string): StreamingReply {
  return { messageId, parentId: '', model: '', content: '', reasoning: '' };
}

export const useChatStore = create<ChatState>((set, get) => ({
  configured: null,
  defaultModel: null,
  conversations: [],
  currentId: null,
  messages: [],
  generating: false,
  streaming: null,
  catalog: [],
  catalogStatus: 'idle',
  error: null,

  checkHealth: async () => {
    try {
      const health = await request<{ chat?: { configured: boolean; defaultModel: string } }>(
        '/health',
        'Health check failed'
      );
      set({ configured: health.chat?.configured ?? false, defaultModel: health.chat?.defaultModel ?? null });
    } catch {
      set({ configured: false });
    }
  },

  loadConversations: async () => {
    try {
      const conversations = await request<Conversation[]>('/api/conversations', 'Failed to load conversations');
      set({ conversations: [...conversations].sort(byRecentActivity) });
    } catch (error) {
      set({ error: errorMessage(error, 'Failed to load conversations') });
    }
  },

  createConversation: async (input = {}) => {
    try {
      const conversation = await request<Conversation>(
        '/api/conversations',
        'Failed to create conversation',
        jsonBody('POST', input)
      );
      set((state) => ({ conversations: upsert(state.conversations, conversation) }));
      await get().openConversation(conversation.id);
      return conversation;
    } catch (error) {
      set({ error: errorMessage(error, 'Failed to create conversation') });
      return undefined;
    }
  },

  openConversation: async (id) => {
    set({ currentId: id, messages: [], error: null, ...idle });
    try {
      const detail = await request<ConversationDetail>(`/api/conversations/${id}`, 'Failed to load conversation');
      if (get().currentId !== id) return; // switched away while loading
      const { messages, generating, ...conversation } = detail;
      set((state) => ({
        messages,
        generating: generating === true,
        conversations: upsert(state.conversations, conversation)
      }));
    } catch (error) {
      if (get().currentId !== id) return;
      set({ error: errorMessage(error, 'Failed to load conversation') });
    }
  },

  closeConversation: () => set({ currentId: null, messages: [], ...idle }),

  updateConversation: async (id, patch) => {
    try {
      const updated = await request<Conversation>(
        `/api/conversations/${id}`,
        'Failed to update conversation',
        jsonBody('PATCH', patch)
      );
      set((state) => ({ conversations: upsert(state.conversations, updated) }));
      return updated;
    } catch (error) {
      set({ error: errorMessage(error, 'Failed to update conversation') });
      return undefined;
    }
  },

  deleteConversation: async (id) => {
    try {
      await request<void>(`/api/conversations/${id}`, 'Failed to delete conversation', { method: 'DELETE' });
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        ...(state.currentId === id ? { currentId: null, messages: [], ...idle } : {})
      }));
      return true;
    } catch (error) {
      set({ error: errorMessage(error, 'Failed to delete conversation') });
      return false;
    }
  },

  loadCatalog: async (force = false) => {
    const { catalogStatus } = get();
    if (catalogStatus === 'loading' || (catalogStatus === 'ready' && !force)) return;
    set({ catalogStatus: 'loading' });
    try {
      const { models } = await request<{ models: ChatModel[] }>(
        `/api/models${force ? '?refresh=1' : ''}`,
        'Failed to load the model catalog'
      );
      set({ catalog: models, catalogStatus: 'ready' });
    } catch (error) {
      set({ catalogStatus: 'error', error: errorMessage(error, 'Failed to load the model catalog') });
    }
  },

  clearError: () => set({ error: null }),

  handleUserMessage: ({ conversationId, message }) => {
    if (conversationId !== get().currentId) return;
    set((state) => {
      const current = state.conversations.find((c) => c.id === conversationId);
      const autoTitle =
        current && current.title === DEFAULT_CONVERSATION_TITLE && current.activeLeafId === null
          ? deriveTitle(message.content)
          : undefined;
      return {
        messages: [...state.messages, message],
        generating: true,
        conversations: patchConversation(state.conversations, conversationId, {
          activeLeafId: message.id,
          updatedAt: message.createdAt,
          ...(autoTitle ? { title: autoTitle } : {})
        })
      };
    });
  },

  handleStart: (event) => {
    if (event.conversationId !== get().currentId) return;
    set({
      streaming: {
        messageId: event.messageId,
        parentId: event.parentId,
        model: event.model,
        content: '',
        reasoning: ''
      },
      generating: true
    });
  },

  handleToken: (event) => {
    if (event.conversationId !== get().currentId) return;
    set((state) => {
      // Joining mid-stream (a reconnect) means no chat:start was seen.
      const reply =
        state.streaming && state.streaming.messageId === event.messageId
          ? state.streaming
          : freshReply(event.messageId);
      return { streaming: { ...reply, content: reply.content + event.token }, generating: true };
    });
  },

  handleReasoning: (event) => {
    if (event.conversationId !== get().currentId) return;
    set((state) => {
      const reply =
        state.streaming && state.streaming.messageId === event.messageId
          ? state.streaming
          : freshReply(event.messageId);
      return { streaming: { ...reply, reasoning: reply.reasoning + event.text }, generating: true };
    });
  },

  handleComplete: ({ conversationId, message }) => {
    if (conversationId !== get().currentId) return;
    set((state) => ({
      messages: [...state.messages, message],
      ...idle,
      conversations: patchConversation(state.conversations, conversationId, {
        activeLeafId: message.id,
        updatedAt: message.createdAt
      })
    }));
    // The server may have titled the conversation; pick that up.
    void get().loadConversations();
  },

  handleError: ({ conversationId, error, message }) => {
    if (conversationId !== get().currentId) return;
    set((state) => ({
      messages: message ? [...state.messages, message] : state.messages,
      ...idle,
      // A stored failed reply shows its error inline; only turn-level
      // failures (nothing stored) need the banner.
      error: message ? state.error : error,
      conversations: message
        ? patchConversation(state.conversations, conversationId, {
            activeLeafId: message.id,
            updatedAt: message.createdAt
          })
        : state.conversations
    }));
  }
}));
