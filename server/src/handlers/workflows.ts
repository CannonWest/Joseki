import { Router } from 'express';
import type { Workflow, WorkflowEdge, WorkflowNode } from '@maestroai/shared';
import { generateId, validateWorkflow, validateWorkflowStructure } from '@maestroai/shared';
import { Database } from '../db/database';

const router = Router();

// Get all workflows
router.get('/', (req, res) => {
  const db = (req as any).db as Database;
  const workflows = db.getAllWorkflows();
  res.json(workflows);
});

// Get single workflow
router.get('/:id', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  res.json(workflow);
});

// Create workflow
router.post('/', (req, res) => {
  const db = (req as any).db as Database;
  const now = Date.now();
  
  const workflow: Workflow = {
    id: generateId(),
    name: req.body.name || 'Untitled Workflow',
    nodes: req.body.nodes || [],
    edges: req.body.edges || [],
    variables: req.body.variables || {},
    createdAt: now,
    updatedAt: now
  };
  
  db.createWorkflow(workflow);
  res.status(201).json(workflow);
});

// Import a workflow file — a bare workflow or an export envelope ({ workflow }).
// Structural problems are rejected; graph problems come back alongside the
// created workflow so they can be fixed in the editor. Registered before the
// /:id routes so "import" is never read as an id.
router.post('/import', (req, res) => {
  const db = (req as any).db as Database;
  const body = req.body;
  const source: unknown =
    body && typeof body === 'object' && body.workflow && typeof body.workflow === 'object'
      ? body.workflow
      : body;

  const structure = validateWorkflowStructure(source);
  if (!structure.ok) {
    return res.status(400).json({ error: 'Invalid workflow file', details: structure.errors });
  }

  const input = source as {
    name?: unknown;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    variables?: Record<string, any>;
  };
  const now = Date.now();
  const workflow: Workflow = {
    id: generateId(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name : 'Imported Workflow',
    nodes: input.nodes,
    edges: input.edges,
    variables: input.variables ?? {},
    createdAt: now,
    updatedAt: now
  };

  db.createWorkflow(workflow);
  res.status(201).json({ workflow, validation: validateWorkflow(workflow) });
});

// Update workflow. Creates it when the id is unknown so workflows the client
// built locally (new / example) can be saved under the id they already have.
router.put('/:id', (req, res) => {
  const db = (req as any).db as Database;
  const existing = db.getWorkflow(req.params.id);

  if (!existing) {
    const draft = {
      nodes: req.body.nodes ?? [],
      edges: req.body.edges ?? [],
      variables: req.body.variables
    };
    const structure = validateWorkflowStructure(draft);
    if (!structure.ok) {
      return res.status(400).json({ error: 'Invalid workflow', details: structure.errors });
    }
    const now = Date.now();
    const created: Workflow = {
      id: req.params.id,
      name: req.body.name || 'Untitled Workflow',
      nodes: draft.nodes,
      edges: draft.edges,
      variables: draft.variables ?? {},
      createdAt: now,
      updatedAt: now
    };
    db.createWorkflow(created);
    return res.status(201).json(created);
  }

  const workflow: Workflow = {
    ...existing,
    name: req.body.name ?? existing.name,
    nodes: req.body.nodes ?? existing.nodes,
    edges: req.body.edges ?? existing.edges,
    variables: req.body.variables ?? existing.variables,
    updatedAt: Date.now()
  };
  
  db.updateWorkflow(workflow);
  res.json(workflow);
});

// Delete workflow
router.delete('/:id', (req, res) => {
  const db = (req as any).db as Database;
  db.deleteWorkflow(req.params.id);
  res.status(204).send();
});

// Export to engine format
router.get('/:id/export', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Convert to engine format
  const engineFormat = {
    version: '1.0.0',
    workflow,
    executionPlan: buildExecutionPlan(workflow)
  };

  res.json(engineFormat);
});

// Graph-level validation of the stored workflow
router.post('/:id/validate', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);

  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }

  res.json(validateWorkflow(workflow));
});

function buildExecutionPlan(workflow: Workflow) {
  // Build DAG and create execution plan
  const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
  const inDegree = new Map<string, number>();
  
  // Initialize in-degrees
  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
  }
  
  // Calculate in-degrees
  for (const edge of workflow.edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }
  
  // Topological sort with parallel group detection
  const plan: Array<{ nodeId: string; dependencies: string[]; parallelGroup?: number }> = [];
  const queue = [...inDegree.entries()].filter(([_, deg]) => deg === 0).map(([id]) => id);
  const processed = new Set<string>();
  let parallelGroup = 0;
  
  while (queue.length > 0) {
    const levelSize = queue.length;
    const levelNodes: string[] = [];
    
    for (let i = 0; i < levelSize; i++) {
      const nodeId = queue.shift()!;
      if (processed.has(nodeId)) continue;
      
      processed.add(nodeId);
      levelNodes.push(nodeId);
      
      // Find dependencies (incoming edges)
      const dependencies = workflow.edges
        .filter(e => e.target === nodeId)
        .map(e => e.source);
      
      plan.push({
        nodeId,
        dependencies,
        parallelGroup: levelSize > 1 ? parallelGroup : undefined
      });
      
      // Reduce in-degree of neighbors
      for (const edge of workflow.edges) {
        if (edge.source === nodeId) {
          const newDegree = (inDegree.get(edge.target) || 0) - 1;
          inDegree.set(edge.target, newDegree);
          if (newDegree === 0) {
            queue.push(edge.target);
          }
        }
      }
    }
    
    if (levelSize > 1) {
      parallelGroup++;
    }
  }
  
  return plan;
}

export { router as workflowRoutes };
