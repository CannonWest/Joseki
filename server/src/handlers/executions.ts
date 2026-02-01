import { Router } from 'express';
import { generateId } from '@maestroai/shared';
import { Database } from '../db/database';
import { WorkflowExecutor } from '../engine/executor';

const router = Router();

// Start execution
router.post('/:workflowId', async (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.workflowId);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  const executionId = generateId();
  const startNodeId = req.body.startNodeId;
  const context = req.body.context || {};
  
  // Create execution record
  db.createExecution({
    id: executionId,
    workflowId: workflow.id,
    status: 'running',
    context,
    startedAt: Date.now()
  });
  
  // Start execution asynchronously
  const executor = new WorkflowExecutor(db);
  
  // Return execution ID immediately
  res.status(202).json({ executionId, status: 'running' });
  
  // Continue execution in background
  try {
    await executor.execute(workflow, executionId, {
      startNodeId,
      context
    });
    
    db.updateExecutionStatus(executionId, 'success', undefined, Date.now());
  } catch (error) {
    db.updateExecutionStatus(
      executionId,
      'error',
      error instanceof Error ? error.message : String(error),
      Date.now()
    );
  }
});

// Get execution status
router.get('/:executionId', (req, res) => {
  const db = (req as any).db as Database;
  
  // This would need a getExecution method on Database
  // For now, return placeholder
  res.json({ 
    id: req.params.executionId,
    status: 'running',
    timestamp: Date.now()
  });
});

// Branch from execution
router.post('/:executionId/branch', async (req, res) => {
  const db = (req as any).db as Database;
  const { nodeId, modifications } = req.body;
  
  const newExecutionId = generateId();
  
  // Clone execution with modifications
  // This would need more implementation
  
  res.status(201).json({ 
    executionId: newExecutionId,
    parentExecutionId: req.params.executionId,
    branchedFromNode: nodeId
  });
});

export { router as executionRoutes };
