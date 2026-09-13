import type {
  ExecutionStatus,
  ExecutionSummary,
  ExecutionTrace,
  GateDecision
} from '@joseki/shared';

/**
 * How long a run took. A run still going, or one the server never closed out,
 * has no end — so it reads as running rather than as zero.
 */
export function runDuration(run: Pick<ExecutionSummary, 'startedAt' | 'completedAt'>): string {
  if (run.completedAt === undefined) return '—';

  const seconds = (run.completedAt - run.startedAt) / 1000;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * A run's spend. Workflow runs are cheap enough that two decimal places round
 * every one of them to nothing, so small amounts keep their significant digits
 * and a genuinely free run says free.
 */
export function runCost(totalCost: number): string {
  if (!totalCost) return 'free';
  if (totalCost < 0.01) return `$${totalCost.toFixed(4)}`;
  return `$${totalCost.toFixed(2)}`;
}

/** When a run happened: the clock for today, the date before that. */
export function runWhen(startedAt: number, now: Date = new Date()): string {
  const started = new Date(startedAt);
  const sameDay =
    started.getFullYear() === now.getFullYear() &&
    started.getMonth() === now.getMonth() &&
    started.getDate() === now.getDate();

  return sameDay
    ? started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : started.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Tailwind classes for a run's outcome, matching the node borders on canvas. */
export function statusTone(status: ExecutionStatus): string {
  switch (status) {
    case 'success':
      return 'text-green-400';
    case 'error':
      return 'text-red-400';
    case 'paused':
      return 'text-amber-400';
    case 'running':
      return 'text-blue-400';
    default:
      return 'text-slate-400';
  }
}

/** What one node attempt reads like in the log, live or read back from history. */
type LoggedTrace = Pick<ExecutionTrace, 'status' | 'error' | 'latencyMs' | 'detail' | 'input'>;

/**
 * Turns node ids into the labels on the canvas.
 *
 * Labels are looked up live rather than recorded with the run, so an old
 * run's log still names nodes the way the canvas does and stays navigable
 * after a rename. A node that has since been deleted keeps its id, which is
 * the only name left for it.
 */
export type LabelOf = (nodeId: string) => string;

/** The identity lookup: every node reads as its own id. */
export const byId: LabelOf = (nodeId) => nodeId;

/** `a`, `a and b`, `a, b and c` — for naming the nodes that skipped a path. */
function readList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a gate's reviewer decided. Recorded as the gate's input since before
 * traces carried a `detail`, so it is read from there for every run, old or
 * new.
 */
function gateDecision(trace: LoggedTrace): GateDecision | undefined {
  const decision = (trace.input as { decision?: GateDecision } | null)?.decision;
  return decision?.verdict ? decision : undefined;
}

/**
 * A node attempt's line in the log.
 *
 * A node that decided something says what it decided: which way a branch went
 * and on what condition, what a reviewer chose at a gate, and for a node that
 * never ran, which node went the other way instead. A node that ended on its
 * fallback value succeeded, but the failure it recovered from is the part
 * worth reading — so the line says both, rather than reporting a clean success
 * the run did not actually have.
 */
export function traceLine(nodeId: string, trace: LoggedTrace, labelOf: LabelOf = byId): string {
  const name = labelOf(nodeId);

  if (trace.status === 'skipped') {
    const by = trace.detail?.skippedBy;
    return by?.length
      ? `${name} skipped — ${readList(by.map(labelOf))} went the other way`
      : `${name} skipped: its path was not taken`;
  }
  if (trace.status === 'error') return `${name} failed: ${trace.error ?? 'no reason given'}`;

  const took = trace.latencyMs ? ` · ${(trace.latencyMs / 1000).toFixed(1)}s` : '';

  if (trace.error) return `${name} carried on with its fallback after: ${trace.error}`;

  const decision = gateDecision(trace);
  if (decision) {
    const verdict = decision.verdict === 'pass' ? 'approved' : 'sent back';
    const edited = decision.verdict === 'pass' && decision.edited !== undefined ? ', with edits' : '';
    const note = decision.note ? ` — "${decision.note}"` : '';
    return `${name} ${verdict}${edited}${note}${took}`;
  }

  const { condition, handle } = trace.detail ?? {};
  if (handle && condition) return `${name} → ${handle} · ${condition}${took}`;
  if (handle) return `${name} → ${handle}${took}`;

  return `${name} — ${trace.status}${took}`;
}

/**
 * A lookup over the nodes on the canvas. A node with no label of its own, or
 * one that has since been deleted, reads as its id — the only name left for it.
 */
export function labelsOf(nodes: Array<{ id: string; data?: { label?: string } }>): LabelOf {
  const labels = new Map(nodes.map((n) => [n.id, n.data?.label]));
  return (nodeId) => labels.get(nodeId) || nodeId;
}

/** The tone that line reads in. A recovery is neither a clean success nor a failure. */
export function traceTone(trace: Pick<LoggedTrace, 'status' | 'error'>): 'info' | 'error' | 'success' {
  if (trace.status === 'error') return 'error';
  if (trace.status === 'success') return trace.error ? 'info' : 'success';
  return 'info';
}

/**
 * The line under a run's heading: what it touched, and what it cost. A node
 * that ran more than once is worth saying out loud — a gate sent work back, or
 * the node failed and tried again — so attempts are named whenever they
 * outnumber the nodes.
 */
export function runShape(run: ExecutionSummary): string {
  const nodes = `${run.nodeCount} node${run.nodeCount === 1 ? '' : 's'}`;
  const attempts = run.traceCount > run.nodeCount ? `, ${run.traceCount} attempts` : '';
  const tokens = run.totalTokens ? ` · ${run.totalTokens.toLocaleString()} tok` : '';

  return `${nodes}${attempts}${tokens} · ${runCost(run.totalCost)}`;
}
