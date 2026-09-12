import { useEffect, useState } from 'react';
import type { ChatParamsPatch, Conversation } from '@joseki/shared';
import { useChatStore } from '../../stores/chatStore';
import { RoutingSection } from './settings/RoutingSection';
import { SamplingSection } from './settings/SamplingSection';
import { ReasoningSection } from './settings/ReasoningSection';
import { fieldClass } from './settings/fields';

interface ChatSettingsProps {
  conversation: Conversation;
  /** `params` is a merge patch: the field that changed, `null` to clear it. */
  onChange: (patch: { systemPrompt?: string | null; params?: ChatParamsPatch }) => void;
  onPickModel: () => void;
}

export function ChatSettings({ conversation, onChange, onPickModel }: ChatSettingsProps) {
  const loadCatalog = useChatStore((state) => state.loadCatalog);
  // The catalog record gates the OpenRouter sections; undefined until the
  // catalog loads, or for a model id it does not list.
  const model = useChatStore((state) => state.catalog.find((entry) => entry.id === conversation.model));
  const [systemPrompt, setSystemPrompt] = useState(conversation.systemPrompt ?? '');
  const [temperature, setTemperature] = useState(conversation.params.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(conversation.params.maxTokens ?? 4096);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

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

  const patchParams = (params: ChatParamsPatch) => onChange({ params });

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
            className={`${fieldClass} resize-y`}
          />
        </div>

        <div>
          <label className="flex justify-between text-xs text-slate-400 mb-1">
            <span>
              Temperature
              {model && !model.supportedParameters.includes('temperature') && (
                <span className="text-slate-500"> — not used by this model</span>
              )}
            </span>
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
            className={fieldClass}
          />
        </div>

        <RoutingSection conversation={conversation} model={model} onChange={patchParams} />
        <SamplingSection conversation={conversation} model={model} onChange={patchParams} />
        <ReasoningSection conversation={conversation} model={model} onChange={patchParams} />

        <p className="text-xs text-slate-500">Changes apply from the next message.</p>
      </div>
    </aside>
  );
}
