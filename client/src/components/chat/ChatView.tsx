import { useEffect, useState, type ReactNode } from 'react';
import { activePath } from '@maestroai/shared';
import type { ChatParams } from '@maestroai/shared';
import { useChatStore } from '../../stores/chatStore';
import { useChatSocket } from '../../hooks/useChatSocket';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { ChatSettings } from './ChatSettings';
import { EditableTitle } from './EditableTitle';
import { shortModel } from './format';

interface ChatViewProps {
  onOpenWorkflows: () => void;
}

const secondaryButton =
  'px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors';

function Banner({
  tone,
  children,
  onClose
}: {
  tone: 'warn' | 'error';
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      role="alert"
      className={`flex items-center gap-3 px-4 py-2 text-sm border-b ${
        tone === 'error'
          ? 'bg-red-900/30 text-red-200 border-red-900/50'
          : 'bg-amber-900/30 text-amber-200 border-amber-900/50'
      }`}
    >
      <span className="flex-1">{children}</span>
      {onClose && (
        <button onClick={onClose} className="opacity-70 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

export function ChatView({ onOpenWorkflows }: ChatViewProps) {
  const configured = useChatStore((state) => state.configured);
  const conversations = useChatStore((state) => state.conversations);
  const currentId = useChatStore((state) => state.currentId);
  const messages = useChatStore((state) => state.messages);
  const streaming = useChatStore((state) => state.streaming);
  const generating = useChatStore((state) => state.generating);
  const error = useChatStore((state) => state.error);
  const {
    checkHealth,
    loadConversations,
    createConversation,
    openConversation,
    updateConversation,
    deleteConversation,
    clearError
  } = useChatStore.getState();

  const { isConnected, send, cancel } = useChatSocket();
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    void checkHealth();
    void loadConversations();
  }, [checkHealth, loadConversations]);

  const conversation = conversations.find((c) => c.id === currentId) ?? null;
  const thread = conversation ? activePath(messages, conversation.activeLeafId) : [];
  const busy = generating || streaming !== null;
  const disabled = !conversation || configured === false || !isConnected;

  const handleSend = (content: string) => {
    if (!conversation) return;
    clearError();
    send({ conversationId: conversation.id, content });
  };

  const handleCancel = () => {
    if (conversation) cancel(conversation.id);
  };

  const handleDelete = async (id: string) => {
    const target = conversations.find((c) => c.id === id);
    if (!target || !window.confirm(`Delete "${target.title}"?`)) return;
    await deleteConversation(id);
  };

  const handleModel = async (model: string) => {
    setShowPicker(false);
    if (conversation && model !== conversation.model) await updateConversation(conversation.id, { model });
  };

  const handleRename = async (title: string) => {
    if (conversation) await updateConversation(conversation.id, { title });
  };

  const handleSettings = async (patch: { systemPrompt?: string | null; params?: ChatParams }) => {
    if (conversation) await updateConversation(conversation.id, patch);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-950">
      <ConversationList
        conversations={conversations}
        currentId={currentId}
        onSelect={(id) => void openConversation(id)}
        onNew={() => void createConversation()}
        onDelete={(id) => void handleDelete(id)}
        onOpenWorkflows={onOpenWorkflows}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 gap-3">
          {conversation ? (
            <>
              <EditableTitle value={conversation.title} onChange={(title) => void handleRename(title)} />
              <div className="flex-1" />
              <button
                onClick={() => setShowPicker(true)}
                className={`${secondaryButton} whitespace-nowrap`}
                title={conversation.model}
              >
                {shortModel(conversation.model)} ▾
              </button>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  showSettings ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Settings
              </button>
            </>
          ) : (
            <>
              <span className="text-sm text-slate-400">Chat</span>
              <div className="flex-1" />
            </>
          )}
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-slate-500">{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </header>

        {configured === false && (
          <Banner tone="warn">
            Chat is disabled — set OPENROUTER_API_KEY in server/.env and restart the server.
          </Banner>
        )}
        {error && (
          <Banner tone="error" onClose={clearError}>
            {error}
          </Banner>
        )}

        <div className="flex-1 flex min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            {conversation ? (
              <>
                <MessageThread messages={thread} streaming={streaming} generating={generating} />
                <Composer
                  disabled={disabled}
                  busy={busy}
                  placeholder={configured === false ? 'Chat is disabled on this server' : undefined}
                  onSend={handleSend}
                  onCancel={handleCancel}
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500">
                <p className="text-sm">Pick a conversation or start a new one</p>
                <button
                  onClick={() => void createConversation()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors"
                >
                  New conversation
                </button>
              </div>
            )}
          </div>

          {showSettings && conversation && (
            <ChatSettings
              conversation={conversation}
              onChange={(patch) => void handleSettings(patch)}
              onPickModel={() => setShowPicker(true)}
            />
          )}
        </div>
      </div>

      {showPicker && conversation && (
        <ModelPicker
          current={conversation.model}
          onSelect={(model) => void handleModel(model)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
