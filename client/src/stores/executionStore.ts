import { create } from 'zustand';
import type { ExecutionTrace, ExecutionStatus } from '@convchain/shared';

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
  
  startExecution: (executionId: string) => void;
  endExecution: () => void;
  setNodeStatus: (nodeId: string, status: ExecutionStatus, trace?: ExecutionTrace) => void;
  appendStreamToken: (nodeId: string, token: string) => void;
  addLog: (message: string, type: 'info' | 'error' | 'success') => void;
  clearExecution: () => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  isExecuting: false,
  currentExecutionId: null,
  nodeStates: new Map(),
  logs: [],

  startExecution: (executionId) => {
    set({
      isExecuting: true,
      currentExecutionId: executionId,
      nodeStates: new Map(),
      logs: [{ timestamp: Date.now(), message: 'Execution started', type: 'info' }]
    });
  },

  endExecution: () => {
    set((state) => ({
      isExecuting: false,
      logs: [...state.logs, { timestamp: Date.now(), message: 'Execution completed', type: 'success' }]
    }));
  },

  setNodeStatus: (nodeId, status, trace) => {
    set((state) => {
      const newStates = new Map(state.nodeStates);
      const existing = newStates.get(nodeId);
      
      newStates.set(nodeId, {
        status,
        trace,
        streamingContent: existing?.streamingContent || ''
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

  addLog: (message, type) => {
    set((state) => ({
      logs: [...state.logs, { timestamp: Date.now(), message, type }]
    }));
  },

  clearExecution: () => {
    set({
      isExecuting: false,
      currentExecutionId: null,
      nodeStates: new Map(),
      logs: []
    });
  }
}));
