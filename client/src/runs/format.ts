import type { ExecutionStatus, ExecutionSummary, ExecutionTrace } from '@joseki/shared';

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
type LoggedTrace = Pick<ExecutionTrace, 'status' | 'error' | 'latencyMs'>;

/**
 * A node attempt's line in the log.
 *
 * A node that ended on its fallback value succeeded, but the failure it
 * recovered from is the part worth reading — so the line says both, rather
 * than reporting a clean success the run did not actually have.
 */
export function traceLine(nodeId: string, trace: LoggedTrace): string {
  if (trace.status === 'skipped') return `${nodeId} skipped: its path was not taken`;
  if (trace.status === 'error') return `${nodeId} failed: ${trace.error ?? 'no reason given'}`;
  if (trace.error) return `${nodeId} carried on with its fallback after: ${trace.error}`;

  const took = trace.latencyMs ? ` · ${(trace.latencyMs / 1000).toFixed(1)}s` : '';
  return `${nodeId} — ${trace.status}${took}`;
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
