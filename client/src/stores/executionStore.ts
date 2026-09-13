import { create } from 'zustand';
import { byId, traceLine, traceTone, type LabelOf } from '../runs/format';
import type {
  ExecutionDetail,
  ExecutionPausedEvent,
  ExecutionStatus,
  ExecutionTrace
} from '@joseki/shared';

interface NodeExecutionState {
  status: ExecutionStatus;
  trace?: ExecutionTrace;
  streamingContent?: string;
}

interface ExecutionState {
  isExecuting: boolean;
  currentExecutionId: string | null;
  nodeStates: Map<string, NodeExecutionState>;
  logs: Array<{ timestamp: number; message: string; type: 'info' | 'error' | 'success' }>;
  /** The human gate the run is waiting at, if any. */
  pendingGate: ExecutionPausedEvent | null;
  /**
   * A finished run reopened from history, rather than one happening now. The
   * canvas reads the same `nodeStates` either way; this is what tells the UI
   * it is looking at the past.
   */
  viewingRun: ExecutionDetail | null;
  /**
   * Names the nodes in the log. The canvas keeps this in step with what is on
   * it, so the log reads in labels rather than the `prompt-1757…` ids the
   * canvas mints.
   */
  labelOf: LabelOf;

  setLabelOf: (labelOf: LabelOf) => void;
  startExecution: (executionId: string) => void;
  endExecution: (outcome?: 'success' | 'error') => void;
  setNodeStatus: (nodeId: string, status: ExecutionStatus, trace?: ExecutionTrace) => void;
  appendStreamToken: (nodeId: string, token: string) => void;
  setPendingGate: (gate: ExecutionPausedEvent | null) => void;
  addLog: (message: string, type: 'info' | 'error' | 'success') => void;
  loadRun: (run: ExecutionDetail) => void;
  clearExecution: () => void;
}

/**
 * The node states a finished run left behind. Traces arrive in the order they
 * happened, so a node a gate sent back is written more than once and the last
 * attempt wins — which is the state the run ended in.
 */
export function nodeStatesFromTraces(
  traces: ExecutionDetail['traces']
): Map<string, NodeExecutionState> {
  const states = new Map<string, NodeExecutionState>();
  for (const trace of traces) {
    states.set(trace.nodeId, { status: trace.status, trace, streamingContent: '' });
  }
  return states;
}

/**
 * The run's story, as the log panel shows it: one line per node attempt.
 *
 * `labelOf` names the nodes. It reads the canvas as it is now, not as it was
 * — a renamed node is still findable — while what each node *decided* comes
 * from the trace, so the story itself is the run's own.
 */
export function logsFromRun(run: ExecutionDetail, labelOf: LabelOf = byId): ExecutionState['logs'] {
  const logs: ExecutionState['logs'] = [
    {
      timestamp: run.startedAt,
      message: `Run of ${new Date(run.startedAt).toLocaleString()}`,
      type: 'info'
    }
  ];

  for (const trace of run.traces) {
    logs.push({
      timestamp: trace.timestamp,
      message: traceLine(trace.nodeId, trace, labelOf),
      type: traceTone(trace)
    });
  }

  logs.push(
    run.status === 'error'
      ? {
          timestamp: run.completedAt ?? run.startedAt,
          message: run.error ? `Run failed: ${run.error}` : 'Run failed',
          type: 'error'
        }
      : {
          timestamp: run.completedAt ?? run.startedAt,
          message: `Run ${run.status}`,
          type: run.status === 'success' ? 'success' : 'info'
        }
  );

  return logs;
}

export const useExecutionStore = create<ExecutionState>((set, get) => ({
  isExecuting: false,
  currentExecutionId: null,
  nodeStates: new Map(),
  logs: [],
  pendingGate: null,
  viewingRun: null,
  labelOf: byId,

  setLabelOf: (labelOf) => set({ labelOf }),

  // A new run replaces whatever was on the canvas, including a run reopened
  // from history.
  startExecution: (executionId) => {
    set({
      isExecuting: true,
      currentExecutionId: executionId,
      nodeStates: new Map(),
      pendingGate: null,
      viewingRun: null,
      logs: [{ timestamp: Date.now(), message: 'Execution started', type: 'info' }]
    });
  },

  // A failed run has already logged its error; only a finished one gets the
  // closing line.
  endExecution: (outcome = 'success') => {
    set((state) => ({
      isExecuting: false,
      pendingGate: null,
      logs:
        outcome === 'success'
          ? [...state.logs, { timestamp: Date.now(), message: 'Execution completed', type: 'success' }]
          : state.logs
    }));
  },

  // A node that starts again (sent back by a gate) streams from scratch.
  setNodeStatus: (nodeId, status, trace) => {
    set((state) => {
      const newStates = new Map(state.nodeStates);
      const existing = newStates.get(nodeId);

      newStates.set(nodeId, {
        status,
        trace,
        streamingContent: status === 'running' ? '' : existing?.streamingContent || ''
      });

      return { nodeStates: newStates };
    });
  },

  appendStreamToken: (nodeId, token) => {
    set((state) => {
      const newStates = new Map(state.nodeStates);
      const existing = newStates.get(nodeId);

      newStates.set(nodeId, {
        status: 'running',
        streamingContent: (existing?.streamingContent || '') + token,
        trace: existing?.trace
      });

      return { nodeStates: newStates };
    });
  },

  setPendingGate: (gate) => {
    set({ pendingGate: gate });
  },

  addLog: (message, type) => {
    set((state) => ({
      logs: [...state.logs, { timestamp: Date.now(), message, type }]
    }));
  },

  // Put a finished run back on the canvas. Every node that ran shows the
  // status and output it ended with, so the result survives a reload.
  loadRun: (run) => {
    set({
      isExecuting: false,
      currentExecutionId: run.id,
      nodeStates: nodeStatesFromTraces(run.traces),
      pendingGate: null,
      viewingRun: run,
      logs: logsFromRun(run, get().labelOf)
    });
  },

  clearExecution: () => {
    set({
      isExecuting: false,
      currentExecutionId: null,
      nodeStates: new Map(),
      pendingGate: null,
      viewingRun: null,
      logs: []
    });
  }
}));
