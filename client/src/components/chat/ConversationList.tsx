import type { Conversation } from '@maestroai/shared';
import { relativeTime, shortModel } from './format';

interface ConversationListProps {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenWorkflows: () => void;
}

export function ConversationList({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onOpenWorkflows
}: ConversationListProps) {
  return (
    <aside className="w-72 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
      <div className="h-14 border-b border-slate-800 flex items-center px-3 gap-2">
        <button
          onClick={onOpenWorkflows}
          className="text-sm text-slate-400 hover:text-white transition-colors"
          title="Back to the workflow editor"
        >
          ← Workflows
        </button>
        <div className="flex-1" />
        <button
          onClick={onNew}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {conversations.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">No conversations yet</p>
        ) : (
          conversations.map((conversation) => {
            const active = conversation.id === currentId;
            return (
              <div
                key={conversation.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(conversation.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSelect(conversation.id);
                }}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer ${
                  active ? 'bg-slate-800' : 'hover:bg-slate-800/60'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-200 truncate">{conversation.title}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {shortModel(conversation.model)} · {relativeTime(conversation.updatedAt)}
                  </div>
                </div>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(conversation.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-slate-500 hover:text-red-400 transition-opacity"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
