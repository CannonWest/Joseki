import { create } from 'zustand';
import type { Workflow, WorkflowNode, WorkflowEdge, WorkflowValidation } from '@maestroai/shared';

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    const details = Array.isArray(body.details) ? `: ${body.details.join('; ')}` : '';
    return `${body.error || fallback}${details}`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

interface WorkflowState {
  workflows: Workflow[];
  currentWorkflow: Workflow | null;
  isLoading: boolean;
  error: string | null;

  loadWorkflows: () => Promise<void>;
  loadWorkflow: (id: string) => Promise<void>;
  setCurrentWorkflow: (workflow: Workflow | null) => void;
  saveWorkflow: (workflow: Workflow) => Promise<void>;
  /** Write the workflow to the server without replacing currentWorkflow (so the canvas is not reset). */
  persistWorkflow: (workflow: Workflow) => Promise<Workflow>;
  /** Create a new workflow from a parsed export file; returns it with its validation report. */
  importWorkflow: (file: unknown) => Promise<{ workflow: Workflow; validation: WorkflowValidation }>;
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

  persistWorkflow: async (workflow) => {
    const response = await fetch(`/api/workflows/${workflow.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow)
    });
    if (!response.ok) {
      throw new Error(await readError(response, 'Failed to save workflow'));
    }
    const saved: Workflow = await response.json();
    get().loadWorkflows();
    return saved;
  },

  importWorkflow: async (file) => {
    const response = await fetch('/api/workflows/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(file)
    });
    if (!response.ok) {
      throw new Error(await readError(response, 'Failed to import workflow'));
    }
    const result = await response.json();
    get().loadWorkflows();
    return result;
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
