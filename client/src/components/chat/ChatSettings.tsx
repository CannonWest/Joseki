import { useEffect, useState } from 'react';
import type { ChatParams, Conversation } from '@maestroai/shared';

interface ChatSettingsProps {
  conversation: Conversation;
  onChange: (patch: { systemPrompt?: string | null; params?: ChatParams }) => void;
  onPickModel: () => void;
}

const field =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500';

export function ChatSettings({ conversation, onChange, onPickModel }: ChatSettingsProps) {
  const [systemPrompt, setSystemPrompt] = useState(conversation.systemPrompt ?? '');
  const [temperature, setTemperature] = useState(conversation.params.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(conversation.params.maxTokens ?? 4096);

  useEffect(() => {
    setSystemPrompt(conversation.systemPrompt ?? '');
    setTemperature(conversation.params.temperature ?? 0.7);
    setMaxTokens(conversation.params.maxTokens ?? 4096);
  }, [conversation.id, conversation.systemPrompt, conversation.params]);

  const commitSystemPrompt = () => {
    const next = systemPrompt.trim() ? systemPrompt : null;
    if (next !== (conversation.systemPrompt ?? null)) onChange({ systemPrompt: next });
  };

  const commitTemperature = (value: number) => {
    if (value !== conversation.params.temperature) onChange({ params: { temperature: value } });
  };

  const commitMaxTokens = () => {
    const value = Math.max(1, Math.round(maxTokens || 1));
    setMaxTokens(value);
    if (value !== conversation.params.maxTokens) onChange({ params: { maxTokens: value } });
  };

  return (
    <aside className="w-80 shrink-0 bg-slate-900 border-l border-slate-800 flex flex-col overflow-y-auto">
      <div className="h-12 border-b border-slate-800 flex items-center px-4">
        <h3 className="font-semibold text-slate-200">Settings</h3>
      </div>

      <div className="p-4 space-y-5">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Model</label>
          <button
            onClick={onPickModel}
            className="w-full text-left px-3 py-2 bg-slate-800 border border-slate-700 rounded font-mono text-xs text-slate-200 hover:border-blue-500 transition-colors truncate"
            title="Choose a model"
          >
            {conversation.model}
          </button>
        </div>

        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span>
            <span className="block text-sm text-slate-200">Tools</span>
            <span className="block text-xs text-slate-500">Let the model run workflows and the built-in tools</span>
          </span>
          <input
            type="checkbox"
            checked={conversation.params.tools !== false}
            onChange={(event) => onChange({ params: { tools: event.target.checked } })}
            className="h-4 w-4 accent-blue-500"
          />
        </label>

        <div>
          <label className="block text-xs text-slate-400 mb-1">System prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            onBlur={commitSystemPrompt}
            rows={6}
            placeholder="Optional instructions for the model"
            className={`${field} resize-y`}
          />
        </div>

        <div>
          <label className="flex justify-between text-xs text-slate-400 mb-1">
            <span>Temperature</span>
            <span className="text-slate-300">{temperature.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(event) => setTemperature(Number(event.target.value))}
            onMouseUp={(event) => commitTemperature(Number(event.currentTarget.value))}
            onTouchEnd={(event) => commitTemperature(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitTemperature(Number(event.currentTarget.value))}
            className="w-full accent-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Max tokens</label>
          <input
            type="number"
            min={1}
            value={maxTokens}
            onChange={(event) => setMaxTokens(Number(event.target.value))}
            onBlur={commitMaxTokens}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            className={field}
          />
        </div>

        <p className="text-xs text-slate-500">Changes apply from the next message.</p>
      </div>
    </aside>
  );
}
