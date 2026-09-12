import type { ChatMessage, ChatModel, ChatTokenUsage } from '@joseki/shared';

/** `openai/gpt-4o-mini` → `gpt-4o-mini` */
export function shortModel(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * What a reply cost by the catalog's per-million prices — for a reply the
 * gateway reported no cost for. The gateway's completion count already
 * includes reasoning tokens. Undefined without usage or without a price;
 * a stopped reply has no usage at all, so it never gets an invented figure.
 */
export function estimateCost(
  usage: ChatTokenUsage | undefined,
  model: ChatModel | undefined
): number | undefined {
  if (!usage || !model || usage.total <= 0) return undefined;
  const { prompt, completion } = model.pricing;
  if (prompt === null || completion === null) return undefined;
  return (usage.prompt * prompt + usage.completion * completion) / 1_000_000;
}

/**
 * What the whole conversation cost — every branch, since every branch was
 * paid for: reported costs, plus catalog estimates for replies without one.
 * `estimated` says an estimate went in. Null while nothing is priceable.
 */
export function conversationSpend(
  messages: ChatMessage[],
  catalog: ChatModel[]
): { total: number; estimated: boolean } | null {
  let total = 0;
  let estimated = false;
  let priced = false;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.cost !== undefined) {
      total += message.cost;
      priced = true;
      continue;
    }
    const estimate = estimateCost(
      message.tokenUsage,
      catalog.find((model) => model.id === message.model)
    );
    if (estimate !== undefined) {
      total += estimate;
      estimated = true;
      priced = true;
    }
  }
  return priced ? { total, estimated } : null;
}

export function formatCost(usd: number | undefined): string | null {
  if (usd === undefined || !Number.isFinite(usd)) return null;
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  const short = usd.toPrecision(2);
  return `$${short.includes('e') ? usd.toFixed(8) : short}`;
}

export function formatTokens(total: number | undefined, thinking?: number): string | null {
  // A stopped reply never receives its usage; 0 would misreport it as free.
  if (!total) return null;
  const count = total >= 10000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  // Reasoning tokens are part of the total; naming them shows the thinking
  // that the trace-less models (OpenAI's) never otherwise reveal.
  return thinking ? `${count} tokens (${thinking} thinking)` : `${count} tokens`;
}

export function formatLatency(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * What to say about a max-tokens setting the model will not honour.
 *
 * Context and output come out of one budget, and a model publishes a ceiling
 * on the output half — often a small fraction of the window: a million tokens
 * of context and eight thousand out is a real combination. Asking for more
 * than the ceiling is refused at the gateway, which is late to find out.
 * Null when there is nothing to say: no setting, no catalog record, or a
 * model that publishes no ceiling (the openrouter/* routers do not, since
 * they resolve to some other model).
 */
export function maxTokensWarning(
  maxTokens: number | undefined,
  model: Pick<ChatModel, 'maxCompletionTokens' | 'contextLength'> | undefined
): string | null {
  const cap = model?.maxCompletionTokens;
  if (!maxTokens || !cap || maxTokens <= cap) return null;
  return `This model emits at most ${formatContext(cap)} tokens — asking for ${formatContext(maxTokens)} will be refused.`;
}

export function formatContext(tokens: number | undefined): string {
  if (!tokens) return '—';
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** USD per million tokens */
export function formatPerMillion(price: number | null): string {
  if (price === null) return '—';
  if (price === 0) return 'free';
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price >= 10 ? price.toFixed(0) : price.toFixed(1)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** JSON text re-indented for reading; anything else as it came. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
