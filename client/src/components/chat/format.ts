/** `openai/gpt-4o-mini` → `gpt-4o-mini` */
export function shortModel(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function formatCost(usd: number | undefined): string | null {
  if (usd === undefined || !Number.isFinite(usd)) return null;
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  const short = usd.toPrecision(2);
  return `$${short.includes('e') ? usd.toFixed(8) : short}`;
}

export function formatTokens(total: number | undefined): string | null {
  // A stopped reply never receives its usage; 0 would misreport it as free.
  if (!total) return null;
  const count = total >= 10000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return `${count} tokens`;
}

export function formatLatency(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
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
