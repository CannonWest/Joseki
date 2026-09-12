import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ChatModel, ModelEndpoint, ServiceTier } from '@joseki/shared';
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
  return name;
}

/** How a tier reads where it is being chosen, and what it means underneath. */
const TIER_LABEL: Record<ServiceTier, string> = {
  flex: 'cheaper, slower',
  priority: 'faster, pricier'
};

const TIER_NOTE: Record<ServiceTier, string> = {
  flex: 'A discounted tier the provider serves at lower priority. It never falls back to a standard endpoint, so a request is refused rather than quietly costing more.',
  priority: 'Priority endpoints are tried first, at a premium, falling back to standard ones if none succeed.'
};

/**
 * The tiers this model can actually be served at, read off its provider
 * roster, cheapest endpoint first for each.
 *
 * A tier is an endpoint, not a property of the model — OpenRouter lists
 * `openai/flex` and `google-ai-studio/priority` beside the plain ones — and
 * most models have none. Deriving the choice from the roster is what keeps a
 * tier from being offered where asking for it would do nothing at all: the
 * gateway ignores a tier it cannot honour rather than complaining.
 */
export function tiersOf(endpoints: ModelEndpoint[] | undefined): Map<ServiceTier, ModelEndpoint> {
  const found = new Map<ServiceTier, ModelEndpoint>();
  for (const endpoint of endpoints ?? []) {
    const slug = endpoint.providerSlug ?? '';
    const tier: ServiceTier | null = slug.endsWith('/flex')
      ? 'flex'
      : slug.endsWith('/priority') || slug.endsWith('/fast')
        ? 'priority'
        : null;
    if (!tier) continue;
    const best = found.get(tier);
    if (!best || (endpoint.pricing.prompt ?? Infinity) < (best.pricing.prompt ?? Infinity)) {
      found.set(tier, endpoint);
    }
  }
  return found;
}

/**
 * A model and a tier in one menu value. A model id cannot contain a pipe, so
 * the two come apart again cleanly.
 */
const TIER_SEP = '|';

export function encodeChoice(id: string, tier: ServiceTier | undefined): string {
  return tier ? `${id}${TIER_SEP}${tier}` : id;
}

export function decodeChoice(value: string): [id: string, tier: ServiceTier | undefined] {
  const cut = value.lastIndexOf(TIER_SEP);
  if (cut === -1) return [value, undefined];
  return [value.slice(0, cut), value.slice(cut + 1) as ServiceTier];
}

const selectClass =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500';

interface ModelSelectProps {
  value: string;
  /** The tier chosen alongside the model; both change together. */
  tier?: ServiceTier | undefined;
  onChange: (id: string, tier: ServiceTier | undefined) => void;
}

/**
 * Picking a model in two steps: its author, then the model itself.
 *
 * Most of the time the author is already known, and narrowing the catalog to
 * one shop's dozen is faster than searching. Search is still here for the
 * times it is not, over the same catalog.
 *
 * A model served at more than one speed lists those beside itself rather than
 * through a control of their own, which is also how OpenRouter says it — its
 * `:floor` and `:nitro` are model suffixes. A model with one speed simply has
 * one entry, so nothing offers a choice that would have done nothing.
 */
export function ModelSelect({ value, tier, onChange }: ModelSelectProps) {
  const catalog = useChatStore((state) => state.catalog);
  const catalogStatus = useChatStore((state) => state.catalogStatus);
  const loadCatalog = useChatStore((state) => state.loadCatalog);
  const roster = useChatStore((state) => state.rosters[value]);
  const loadRoster = useChatStore((state) => state.loadRoster);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // The roster is what says which speeds exist, so it is loaded for whichever
  // model is in hand. The store caches it, and the routing section below reads
  // the same copy.
  useEffect(() => {
    if (value) void loadRoster(value);
  }, [value, loadRoster]);

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
  const tiers = useMemo(() => tiersOf(roster?.endpoints), [roster]);

  // A tier already chosen keeps its entry even before the roster arrives,
  // so the menu never reads as though the setting had been dropped.
  const shownTiers = useMemo(() => {
    const list = [...tiers.keys()];
    if (tier && !tiers.has(tier)) list.unshift(tier);
    return list;
  }, [tiers, tier]);

  // A model the catalog does not list keeps its place in both menus rather
  // than being quietly swapped for something else — a workflow stored against
  // an id that has since been withdrawn still says what it was built against.
  const strandedAuthor = !selected && value && !groups.has(author);
  const strandedModel = !selected && value;

  const pickAuthor = (next: string) => {
    const first = groups.get(next)?.[0];
    // A new model brings its own speeds; the old one's would not apply.
    if (first) onChange(first.id, undefined);
  };

  const priced = tier ? tiers.get(tier) : undefined;
  const prompt = priced ? priced.pricing.prompt : selected?.pricing.prompt ?? null;
  const completion = priced ? priced.pricing.completion : selected?.pricing.completion ?? null;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="w-[38%] shrink-0">
          <label className="block text-xs font-medium text-slate-400 mb-1">Author</label>
          <select
            value={author}
            onChange={(event) => pickAuthor(event.target.value)}
            className={selectClass}
            title={author}
          >
            {strandedAuthor && <option value={author}>{author || '—'} (not in the catalog)</option>}
            {authors.map((key) => (
              <option key={key} value={key}>
                {authorLabel(groups.get(key)!, key)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between mb-1 gap-2">
            <label className="block text-xs font-medium text-slate-400">Model</label>
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap"
              title="Search the whole catalog by name, id or description"
            >
              search{catalog.length ? ` all ${catalog.length}` : ''}…
            </button>
          </div>
          <select
            value={encodeChoice(value, tier)}
            onChange={(event) => onChange(...decodeChoice(event.target.value))}
            className={selectClass}
          >
            {strandedModel && <option value={value}>{slug} (not in the catalog)</option>}
            {models.map((model) => (
              <Fragment key={model.id}>
                <option value={model.id}>{modelLabel(model)}</option>
                {model.id === value &&
                  shownTiers.map((name) => (
                    <option key={name} value={encodeChoice(model.id, name)}>
                      {modelLabel(model)} · {TIER_LABEL[name]}
                    </option>
                  ))}
              </Fragment>
            ))}
          </select>
        </div>
      </div>

      {tier && <p className="text-xs text-slate-500">{TIER_NOTE[tier]}</p>}

      <p className="text-xs text-slate-500">
        {selected ? (
          <>
            <span className="font-mono text-slate-400">{selected.id}</span> ·{' '}
            {formatContext(selected.contextLength)} ctx
            {selected.maxCompletionTokens ? ` · ${formatContext(selected.maxCompletionTokens)} out` : ''} ·{' '}
            {formatPerMillion(prompt)} / {formatPerMillion(completion)} per M
            {priced ? ` · ${TIER_LABEL[tier!]}` : ''}
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
            onChange(id, undefined);
            setSearching(false);
          }}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}
