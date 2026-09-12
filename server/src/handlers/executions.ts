import { Router } from 'express';
import { Database } from '../db/database';

const router = Router();

// Runs are started over socket.io (`execution:start`), which is the only
// path: it streams node events and pauses at human gates. A second REST
// starter used to live here and did neither — a gated workflow started that
// way hung at the gate with nothing to answer it — so it was removed rather
// than kept as a copy that silently lacks the feature.

/**
 * Past runs, most recent first. `?workflowId=` narrows to one workflow,
 * `?limit=` caps the list (default 50).
 */
router.get('/', (req, res) => {
  const db = (req as any).db as Database;
  const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId : undefined;

  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : 50;

  res.json(db.listExecutions({ workflowId, limit }));
});

/** One run with every trace it wrote, in the order they happened. */
router.get('/:executionId', (req, res) => {
  const db = (req as any).db as Database;

  const execution = db.getExecutionSummary(req.params.executionId);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }

  res.json({ ...execution, traces: db.getExecutionTraces(execution.id) });
});

export { router as executionRoutes };
