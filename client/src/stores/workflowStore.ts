import { create } from 'zustand';
import type { Workflow, WorkflowNode, WorkflowEdge } from '@convchain/shared';

interface WorkflowState {
  workflows: Workflow[];
  currentWorkflow: Workflow | null;
  isLoading: boolean;
  error: string | null;
  
  loadWorkflows: () => Promise<void>;
  loadWorkflow: (id: string) => Promise<void>;
  setCurrentWorkflow: (workflow: Workflow | null) => void;
  saveWorkflow: (workflow: Workflow) => Promise<void>;
  updateNodes: (nodes: WorkflowNode[]) => void;
  updateEdges: (edges: WorkflowEdge[]) => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  currentWorkflow: null,
  isLoading: false,
  error: null,

  loadWorkflows: async () => {
    set({ isLoading: true });
    try {
      const response = await fetch('/api/workflows');
      const workflows = await response.json();
      set({ workflows, isLoading: false });
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to load workflows',
        isLoading: false 
      });
    }
  },

  loadWorkflow: async (id: string) => {
    set({ isLoading: true });
    try {
      const response = await fetch(`/api/workflows/${id}`);
      const workflow = await response.json();
      set({ currentWorkflow: workflow, isLoading: false });
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to load workflow',
        isLoading: false 
      });
    }
  },

  setCurrentWorkflow: (workflow) => {
    set({ currentWorkflow: workflow });
  },

  saveWorkflow: async (workflow) => {
    try {
      const method = workflow.id ? 'PUT' : 'POST';
      const url = workflow.id ? `/api/workflows/${workflow.id}` : '/api/workflows';
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflow)
      });
      
      const saved = await response.json();
      set({ currentWorkflow: saved });
      
      // Refresh workflows list
      get().loadWorkflows();
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to save workflow'
      });
    }
  },

  updateNodes: (nodes) => {
    const { currentWorkflow } = get();
    if (!currentWorkflow) return;
    
    set({
      currentWorkflow: {
        ...currentWorkflow,
        nodes,
        updatedAt: Date.now()
      }
    });
  },

  updateEdges: (edges) => {
    const { currentWorkflow } = get();
    if (!currentWorkflow) return;
    
    set({
      currentWorkflow: {
        ...currentWorkflow,
        edges,
        updatedAt: Date.now()
      }
    });
  }
}));
