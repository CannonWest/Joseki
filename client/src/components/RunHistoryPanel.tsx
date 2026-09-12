import { useCallback, useEffect, useState } from 'react';
import type { ExecutionDetail, ExecutionSummary } from '@joseki/shared';
import { useExecutionStore } from '../stores/executionStore';
import { runDuration, runShape, runWhen, statusTone } from '../runs/format';

interface RunHistoryPanelProps {
  workflowId: string | undefined;
  onClose: () => void;
}

/**
 * Past runs of this workflow. Every run was already recorded as it happened —
 * this is the way back to one: picking a run puts its results on the canvas,
 * so a result outlives the reload that used to lose it.
 */
export function RunHistoryPanel({ workflowId, onClose }: RunHistoryPanelProps) {
  const [runs, setRuns] = useState<ExecutionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const { loadRun, viewingRun, currentExecutionId, isExecuting } = useExecutionStore();

  const refresh = useCallback(async () => {
    if (!workflowId) {
      setRuns([]);
      return;
    }
    setError(null);
    try {
      const response = await fetch(`/api/executions?workflowId=${encodeURIComponent(workflowId)}`);
      if (!response.ok) throw new Error(`The server answered ${response.status}`);
      setRuns((await response.json()) as ExecutionSummary[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRuns([]);
    }
  }, [workflowId]);

  // Reload when the panel opens, and again each time a run finishes — the run
  // that just ended belongs at the top of the list.
  useEffect(() => {
    refresh();
  }, [refresh, isExecuting]);

  const open = async (id: string) => {
    setOpening(id);
    setError(null);
    try {
      const response = await fetch(`/api/executions/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`The server answered ${response.status}`);
      loadRun((await response.json()) as ExecutionDetail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div
      data-testid="run-history-panel"
      className="w-80 h-full bg-slate-900 border-l border-slate-800 flex flex-col overflow-hidden"
    >
      <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
        <h3 className="font-semibold text-slate-200">Runs</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={refresh}
            className="text-xs text-slate-400 hover:text-white transition-colors"
            title="Reload the list"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <p className="text-sm text-red-300 bg-red-900/30 rounded px-2 py-1">
            Could not read the run history: {error}
          </p>
        )}

        {runs === null && <p className="text-sm text-slate-500">Loading…</p>}

        {runs !== null && runs.length === 0 && !error && (
          <p className="text-sm text-slate-500">
            {workflowId
              ? 'This workflow has not been run yet. Every run is recorded, and will show up here.'
              : 'Save the workflow to start recording its runs.'}
          </p>
        )}

        {runs?.map((run) => {
          const isOpen = viewingRun?.id === run.id;
          const isLive = isExecuting && currentExecutionId === run.id;

          return (
            <button
              key={run.id}
              onClick={() => open(run.id)}
              disabled={opening !== null}
              className={`w-full text-left rounded-md px-3 py-2 border transition-colors ${
                isOpen
                  ? 'bg-blue-950/40 border-blue-700'
                  : 'bg-slate-800/50 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
              } disabled:opacity-60`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-slate-200">{runWhen(run.startedAt)}</span>
                <span className={`text-xs ${statusTone(run.status)}`}>
                  {isLive ? 'running' : run.status}
                </span>
              </div>

              <div className="mt-0.5 text-[11px] text-slate-500">
                {runShape(run)} · {runDuration(run)}
              </div>

              {run.error && (
                <div className="mt-1 text-[11px] text-red-300/90 line-clamp-2 break-words">
                  {run.error}
                </div>
              )}

              {opening === run.id && (
                <div className="mt-1 text-[11px] text-blue-400">Opening…</div>
              )}
            </button>
          );
        })}
      </div>

      {viewingRun && (
        <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-400">
          Showing the run of {runWhen(viewingRun.startedAt)}. Running the workflow replaces it.
        </div>
      )}
    </div>
  );
}
