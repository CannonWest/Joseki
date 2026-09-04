import { useEffect, useMemo, useState } from 'react';
import type { ChatModel } from '@maestroai/shared';
import { useChatStore } from '../../stores/chatStore';
import { formatContext, formatPerMillion } from './format';

interface ModelPickerProps {
  current: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function matches(model: ChatModel, terms: string[]): boolean {
  const haystack = `${model.id} ${model.name} ${model.description ?? ''}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function ModelPicker({ current, onSelect, onClose }: ModelPickerProps) {
  const catalog = useChatStore((state) => state.catalog);
  const status = useChatStore((state) => state.catalogStatus);
  const loadCatalog = useChatStore((state) => state.loadCatalog);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const shown = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length ? catalog.filter((model) => matches(model, terms)) : catalog;
  }, [catalog, query]);

  const summary =
    status === 'loading'
      ? 'Loading the catalog…'
      : status === 'error'
        ? 'Could not load the catalog'
        : `${shown.length} of ${catalog.length} models`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[40rem] max-w-[90vw] h-[70vh] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Choose a model</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void loadCatalog(true)}
              className="text-xs text-slate-400 hover:text-white transition-colors"
              title="Fetch the catalog again"
            >
              Refresh
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="p-3 border-b border-slate-800">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, id or description…"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <div className="mt-1 text-xs text-slate-500">{summary}</div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {shown.map((model) => (
            <button
              key={model.id}
              onClick={() => onSelect(model.id)}
              className={`w-full text-left px-4 py-2 border-b border-slate-800/60 hover:bg-slate-800 transition-colors ${
                model.id === current ? 'bg-blue-600/20' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-slate-200 truncate">{model.name}</div>
                  <div className="text-xs font-mono text-slate-500 truncate">{model.id}</div>
                </div>
                <div className="text-xs text-slate-400 whitespace-nowrap">
                  {formatContext(model.contextLength)} ctx · {formatPerMillion(model.pricing.prompt)} /{' '}
                  {formatPerMillion(model.pricing.completion)} per M
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
