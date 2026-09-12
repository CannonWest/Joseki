import { useEffect, useState } from 'react';
import type {
  ChatModel,
  ChatParams,
  ChatParamsPatch,
  MergePatch,
  ModelEndpoint,
  OpenRouterRouting,
  Quantization
} from '@joseki/shared';
import { useChatStore } from '../../../stores/chatStore';
import { formatPerMillion } from '../format';
import { ModelPicker } from '../ModelPicker';
import { SettingsSection } from './SettingsSection';
import { Chip, Label, NumberField, SelectField, Toggle, countSet } from './fields';

const QUANTIZATIONS: Quantization[] = ['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32', 'unknown'];

type ListName = 'order' | 'only' | 'ignore';

const LISTS: Array<{ name: ListName; label: string; tone: 'blue' | 'green' | 'red'; title: string }> = [
  { name: 'order', label: 'order', tone: 'blue', title: 'Try this provider first — in the order picked' },
  { name: 'only', label: 'only', tone: 'green', title: 'Route only to the providers marked "only"' },
  { name: 'ignore', label: 'skip', tone: 'red', title: 'Never route to this provider' }
];

type RoutingPatch = MergePatch<OpenRouterRouting>;

interface RoutingSectionProps {
  /** The settings in view — a conversation's, or a prompt node's. */
  params: ChatParams;
  /** The model they are for; its provider roster is what the section lists. */
  modelId: string;
  /** Its catalog record; undefined until the catalog loads, or for an id it does not list. */
  model: ChatModel | undefined;
  /** Every write is a merge patch of the one thing that changed. */
  onChange: (patch: ChatParamsPatch) => void;
}

function uptime(value: number | null): string {
  return value === null ? '—' : `${value >= 99.95 ? '100' : value.toFixed(1)}% up`;
}

function throughput(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} tok/s`;
}

/**
 * Provider routing: the model's roster with a tri-state pick per provider
 * (order / only / skip), then the gateway's routing preferences. Every write
 * is a merge patch of the one thing that changed; the lists are the exception
 * — a slug sits in at most one of them, so all three go together.
 */
export function RoutingSection({ params, modelId, model, onChange }: RoutingSectionProps) {
  const routing = params.routing ?? {};
  const roster = useChatStore((state) => state.rosters[modelId]);
  const rosterStatus = useChatStore((state) => state.rosterStatus[modelId]);
  const loadRoster = useChatStore((state) => state.loadRoster);
  const [open, setOpen] = useState(false);
  const [pickingFallback, setPickingFallback] = useState(false);

  useEffect(() => {
    if (open) void loadRoster(modelId);
  }, [open, modelId, loadRoster]);

  const patch = (fields: RoutingPatch) => onChange({ routing: fields });
  const toolsOn = params.tools !== false;
  const order = routing.order ?? [];

  const listOf = (slug: string): ListName | null =>
    order.includes(slug) ? 'order' : routing.only?.includes(slug) ? 'only' : routing.ignore?.includes(slug) ? 'ignore' : null;

  const setList = (slug: string, target: ListName | null) => {
    const next: Record<ListName, string[]> = {
      order: order.filter((item) => item !== slug),
      only: (routing.only ?? []).filter((item) => item !== slug),
      ignore: (routing.ignore ?? []).filter((item) => item !== slug)
    };
    if (target) next[target] = [...next[target], slug];
    patch({
      order: next.order.length ? next.order : null,
      only: next.only.length ? next.only : null,
      ignore: next.ignore.length ? next.ignore : null
    });
  };

  const moveUp = (slug: string) => {
    const index = order.indexOf(slug);
    if (index <= 0) return;
    const next = [...order];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    patch({ order: next });
  };

  const toggleQuantization = (level: Quantization) => {
    const current = routing.quantizations ?? [];
    const next = current.includes(level) ? current.filter((item) => item !== level) : [...current, level];
    patch({ quantizations: next.length ? next : null });
  };

  const fallbacks = routing.fallbackModels ?? [];
  const setFallbacks = (next: string[]) => patch({ fallbackModels: next.length ? next : null });

  // Providers already picked that the roster does not list (set through the
  // API, or the roster is unavailable) still get a row, so nothing is hidden.
  const listed = new Set((roster?.endpoints ?? []).map((endpoint) => endpoint.providerSlug));
  const extras = [...order, ...(routing.only ?? []), ...(routing.ignore ?? [])].filter(
    (slug, index, all) => !listed.has(slug) && all.indexOf(slug) === index
  );

  const renderPicks = (slug: string) => {
    const current = listOf(slug);
    const position = order.indexOf(slug);
    return (
      <>
        {position > 0 && (
          <button
            type="button"
            onClick={() => moveUp(slug)}
            className="px-1 text-xs text-slate-500 hover:text-slate-300"
            title="Try this provider earlier"
          >
            ↑
          </button>
        )}
        {LISTS.map(({ name, label, tone, title }) => (
          <Chip
            key={name}
            active={current === name}
            tone={tone}
            title={title}
            onClick={() => setList(slug, current === name ? null : name)}
          >
            {name === 'order' && position >= 0 ? `#${position + 1}` : label}
          </Chip>
        ))}
      </>
    );
  };

  const renderEndpoint = (endpoint: ModelEndpoint) => (
    <div key={endpoint.providerSlug} className="py-1.5 border-b border-slate-800/60 last:border-0">
      <div className="flex items-center gap-1">
        <span className="flex-1 min-w-0 truncate text-sm text-slate-200" title={endpoint.name}>
          {endpoint.providerSlug}
        </span>
        {renderPicks(endpoint.providerSlug)}
      </div>
      <div className="text-[11px] text-slate-500 truncate">
        {formatPerMillion(endpoint.pricing.prompt)} / {formatPerMillion(endpoint.pricing.completion)} per M ·{' '}
        {endpoint.quantization ?? '—'} · {uptime(endpoint.uptimeLast30m)} · {throughput(endpoint.throughputLast30m)}
        {endpoint.status !== undefined && endpoint.status !== 0 ? ' · degraded' : ''}
      </div>
    </div>
  );

  const rosterLine =
    rosterStatus === 'loading'
      ? 'Loading providers…'
      : rosterStatus === 'error'
        ? 'No provider roster for this model.'
        : roster && roster.endpoints.length === 0
          ? 'The gateway lists no endpoints for this model.'
          : null;

  return (
    <SettingsSection
      title="Routing"
      count={countSet(routing)}
      onReset={() => onChange({ routing: null })}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div>
        <Label
          hint={
            <button
              type="button"
              onClick={() => void loadRoster(modelId, true)}
              className="hover:text-slate-300"
              title="Fetch the roster again"
            >
              refresh
            </button>
          }
        >
          Providers {model ? `for ${model.name}` : ''}
        </Label>
        {rosterLine && <div className="text-xs text-slate-500 py-1">{rosterLine}</div>}
        {roster?.endpoints.map(renderEndpoint)}
        {extras.map((slug) => (
          <div key={slug} className="py-1.5 border-b border-slate-800/60 last:border-0">
            <div className="flex items-center gap-1">
              <span className="flex-1 min-w-0 truncate text-sm text-slate-200">{slug}</span>
              {renderPicks(slug)}
            </div>
            <div className="text-[11px] text-slate-500">not in the roster</div>
          </div>
        ))}
      </div>

      <SelectField
        label="Sort"
        value={routing.sort ?? ''}
        hint="ignored when an order is set"
        options={[
          { value: '', label: 'Load-balanced (default)' },
          { value: 'price', label: 'Cheapest first' },
          { value: 'throughput', label: 'Highest throughput' },
          { value: 'latency', label: 'Lowest latency' }
        ]}
        onChange={(value) => patch({ sort: value === '' ? null : (value as NonNullable<OpenRouterRouting['sort']>) })}
      />

      <Toggle
        label="Allow fallbacks"
        description="Use another provider when the preferred ones fail"
        checked={routing.allowFallbacks !== false}
        onChange={(on) => patch({ allowFallbacks: on ? null : false })}
      />

      <Toggle
        label="Require parameters"
        description={
          routing.requireParameters === undefined && toolsOn
            ? 'Forced on while tools are on — a provider that dropped them would break the tool loop'
            : 'Route only to providers that honour every parameter sent'
        }
        checked={routing.requireParameters ?? toolsOn}
        onChange={(on) => patch({ requireParameters: on })}
      />

      <SelectField
        label="Data collection"
        value={routing.dataCollection ?? ''}
        options={[
          { value: '', label: 'Default (allow)' },
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny — providers that keep nothing' }
        ]}
        onChange={(value) => patch({ dataCollection: value === 'allow' || value === 'deny' ? value : null })}
      />

      <Toggle
        label="Zero data retention"
        description="Only endpoints that do not retain prompts"
        checked={routing.zdr === true}
        onChange={(on) => patch({ zdr: on ? true : null })}
      />

      <div>
        <Label hint="none picked = any">Quantizations</Label>
        <div className="flex flex-wrap gap-1">
          {QUANTIZATIONS.map((level) => (
            <Chip
              key={level}
              active={routing.quantizations?.includes(level) ?? false}
              onClick={() => toggleQuantization(level)}
            >
              {level}
            </Chip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Max prompt $/M"
          value={routing.maxPrice?.prompt}
          min={0}
          step={0.01}
          placeholder="any"
          onCommit={(value) => patch({ maxPrice: { prompt: value } })}
        />
        <NumberField
          label="Max completion $/M"
          value={routing.maxPrice?.completion}
          min={0}
          step={0.01}
          placeholder="any"
          onCommit={(value) => patch({ maxPrice: { completion: value } })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Min throughput"
          hint="tok/s"
          value={routing.preferredMinThroughput}
          min={0}
          step={1}
          placeholder="any"
          onCommit={(value) => patch({ preferredMinThroughput: value })}
        />
        <NumberField
          label="Max latency"
          hint="seconds"
          value={routing.preferredMaxLatency}
          min={0}
          step={0.1}
          placeholder="any"
          onCommit={(value) => patch({ preferredMaxLatency: value })}
        />
      </div>

      <div>
        <Label
          hint={
            <button type="button" onClick={() => setPickingFallback(true)} className="hover:text-slate-300">
              + add
            </button>
          }
        >
          Fallback models
        </Label>
        {fallbacks.length === 0 ? (
          <div className="text-xs text-slate-500">None — the primary model is the only one tried.</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {fallbacks.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700 text-[11px] font-mono text-slate-300"
              >
                {id}
                <button
                  type="button"
                  onClick={() => setFallbacks(fallbacks.filter((item) => item !== id))}
                  className="text-slate-500 hover:text-slate-200"
                  aria-label={`Remove ${id}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {pickingFallback && (
        <ModelPicker
          current=""
          onSelect={(id) => {
            setPickingFallback(false);
            if (id !== modelId && !fallbacks.includes(id)) setFallbacks([...fallbacks, id]);
          }}
          onClose={() => setPickingFallback(false)}
        />
      )}
    </SettingsSection>
  );
}
