import { useEffect, useMemo, useState } from 'react';
import type { ChatModel } from '@joseki/shared';
import { useChatStore } from '../../stores/chatStore';
import { formatContext, formatPerMillion } from './format';
import { ModelPicker } from './ModelPicker';

/**
 * `openai/gpt-4o-mini` → `['openai', 'gpt-4o-mini']`.
 *
 * Split on the FIRST slash only: the half in front is what OpenRouter calls
 * the model's author — the shop that made it, as distinct from the provider
 * that ends up serving the request — and the rest is the slug, which may
 * carry its own punctuation (`anthropic/claude-haiku-4.5:batch`). An id with
 * no slash is all slug.
 */
export function splitModelId(id: string): [author: string, slug: string] {
  const cut = id.indexOf('/');
  return cut === -1 ? ['', id] : [id.slice(0, cut), id.slice(cut + 1)];
}

/**
 * The catalog names a model `OpenAI: GPT-4o-mini`. The half before the colon
 * is the author written the way OpenRouter writes it, which reads better in a
 * menu than the slug; the half after is the model on its own, which is all
 * the second menu needs to say once the first has named the author.
 */
function splitCatalogName(name: string): [author: string | null, model: string] {
  const cut = name.indexOf(': ');
  return cut > 0 ? [name.slice(0, cut), name.slice(cut + 2)] : [null, name];
}

function authorLabel(models: ChatModel[], author: string): string {
  for (const model of models) {
    const [named] = splitCatalogName(model.name);
    if (named) return named;
  }
  return author;
}

function modelLabel(model: ChatModel): string {
  const [, name] = splitCatalogName(model.name);
  return `${name} · ${formatPerMillion(model.pricing.prompt)} / ${formatPerMillion(model.pricing.completion)}`;
}

const selectClass =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500';

interface ModelSelectProps {
  value: string;
  onChange: (id: string) => void;
}

/**
 * Picking a model in two steps: its author, then the model itself.
 *
 * Most of the time the author is already known, and narrowing 445 models to
 * one shop's dozen is faster than searching. Search is still here for the
 * times it is not, over the same catalog.
 */
export function ModelSelect({ value, onChange }: ModelSelectProps) {
  const catalog = useChatStore((state) => state.catalog);
  const catalogStatus = useChatStore((state) => state.catalogStatus);
  const loadCatalog = useChatStore((state) => state.loadCatalog);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const [author, slug] = splitModelId(value);

  const groups = useMemo(() => {
    const map = new Map<string, ChatModel[]>();
    for (const model of catalog) {
      const [key] = splitModelId(model.id);
      const list = map.get(key);
      if (list) list.push(model);
      else map.set(key, [model]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [catalog]);

  const authors = useMemo(() => [...groups.keys()].sort((a, b) => a.localeCompare(b)), [groups]);
  const selected = useMemo(() => catalog.find((model) => model.id === value), [catalog, value]);
  const models = groups.get(author) ?? [];

  // A model the catalog does not list keeps its place in both menus rather
  // than being quietly swapped for something else — a workflow stored against
  // an id that has since been withdrawn still says what it was built against.
  const strandedAuthor = !selected && value && !groups.has(author);
  const strandedModel = !selected && value;

  const pickAuthor = (next: string) => {
    const first = groups.get(next)?.[0];
    if (first) onChange(first.id);
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Author</label>
        <select value={author} onChange={(event) => pickAuthor(event.target.value)} className={selectClass}>
          {strandedAuthor && <option value={author}>{author || '—'} (not in the catalog)</option>}
          {authors.map((key) => (
            <option key={key} value={key}>
              {authorLabel(groups.get(key)!, key)} ({groups.get(key)!.length})
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label className="block text-xs font-medium text-slate-400">Model</label>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            title="Search the whole catalog by name, id or description"
          >
            search{catalog.length ? ` all ${catalog.length}` : ''}…
          </button>
        </div>
        <select value={value} onChange={(event) => onChange(event.target.value)} className={selectClass}>
          {strandedModel && <option value={value}>{slug} (not in the catalog)</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-slate-500">
        {selected ? (
          <>
            <span className="font-mono text-slate-400">{selected.id}</span> ·{' '}
            {formatContext(selected.contextLength)} ctx · {formatPerMillion(selected.pricing.prompt)} /{' '}
            {formatPerMillion(selected.pricing.completion)} per M
          </>
        ) : catalog.length ? (
          <span className="text-amber-400/80">
            <span className="font-mono">{value}</span> is not in the OpenRouter catalog — the gateway will refuse it
          </span>
        ) : catalogStatus === 'error' ? (
          <span className="text-amber-400/80">Could not load the catalog — is OPENROUTER_API_KEY set?</span>
        ) : (
          <>Loading the catalog…</>
        )}
      </p>

      {searching && (
        <ModelPicker
          current={value}
          onSelect={(id) => {
            onChange(id);
            setSearching(false);
          }}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}
