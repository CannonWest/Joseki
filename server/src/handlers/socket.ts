import { Server, Socket } from 'socket.io';
import { validateWorkflow } from '@joseki/shared';
import type { ExecutionResumeRequest } from '@joseki/shared';
import { Database } from '../db/database';
import { WorkflowExecutor } from '../engine/executor';
import { gates } from '../engine/gates';

export function setupSocketHandlers(io: Server, db: Database) {
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', socket.id);

    // Join workflow room for execution updates
    socket.on('subscribe:workflow', (workflowId: string) => {
      socket.join(`workflow:${workflowId}`);
      console.log(`Socket ${socket.id} subscribed to workflow ${workflowId}`);
    });

    // Start execution with streaming
    socket.on('execution:start', async (data: {
      workflowId: string;
      executionId: string;
      startNodeId?: string;
      context?: Record<string, any>;
      /** Values for input nodes, by node id. */
      inputs?: Record<string, unknown>;
    }) => {
      const { workflowId, executionId, startNodeId, context = {}, inputs } = data;
      
      const workflow = db.getWorkflow(workflowId);
      if (!workflow) {
        socket.emit('execution:error', { executionId, error: 'Workflow not found' });
        return;
      }

      const validation = validateWorkflow(workflow);
      if (!validation.valid) {
        socket.emit('execution:error', {
          executionId,
          error: `Workflow is not runnable: ${validation.errors.join('; ')}`,
          validation
        });
        return;
      }

      // Create execution record
      db.createExecution({
        id: executionId,
        workflowId,
        status: 'running',
        context,
        startedAt: Date.now()
      });

      try {
        // Constructed inside the try: the LLM adapter throws when no API key
        // is configured, and that must surface as an execution error rather
        // than an unhandled rejection.
        const executor = new WorkflowExecutor(db);
        await executor.execute(workflow, executionId, {
          startNodeId,
          context,
          inputs,
          onNodeStart: (nodeId) => {
            socket.emit('execution:nodeStart', { executionId, nodeId });
            io.to(`workflow:${workflowId}`).emit('node:status', {
              executionId,
              nodeId,
              status: 'running'
            });
          },
          onNodeComplete: (nodeId, trace) => {
            socket.emit('execution:nodeComplete', { executionId, nodeId, trace });
            io.to(`workflow:${workflowId}`).emit('node:status', {
              executionId,
              nodeId,
              status: trace.status,
              trace
            });
          },
          onStreamToken: (nodeId, token) => {
            socket.emit('execution:token', { executionId, nodeId, token });
          },
          onStreamReasoning: (nodeId, token) => {
            socket.emit('execution:reasoning', { executionId, nodeId, token });
          },
          onPaused: (event) => {
            db.updateExecutionStatus(executionId, 'paused');
            socket.emit('execution:paused', event);
            io.to(`workflow:${workflowId}`).emit('node:status', {
              executionId,
              nodeId: event.nodeId,
              status: 'paused'
            });
          }
        });

        db.updateExecutionStatus(executionId, 'success', undefined, Date.now());
        socket.emit('execution:complete', { executionId });
        io.to(`workflow:${workflowId}`).emit('execution:status', {
          executionId,
          status: 'success'
        });

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        db.updateExecutionStatus(executionId, 'error', errorMsg, Date.now());
        socket.emit('execution:error', { executionId, error: errorMsg });
        io.to(`workflow:${workflowId}`).emit('execution:status', {
          executionId,
          status: 'error',
          error: errorMsg
        });
      }
    });

    // Deliver the reviewer's decision to the gate the run is waiting at.
    // The run itself carries on inside the execution:start handler above.
    socket.on('execution:resume', (data: ExecutionResumeRequest) => {
      const { executionId, nodeId, decision } = data;
      if (!gates.resolve(executionId, nodeId, decision)) {
        socket.emit('execution:resumed', {
          executionId,
          nodeId,
          ok: false,
          error: `Nothing is waiting at gate ${nodeId} of execution ${executionId}`
        });
        return;
      }
      db.updateExecutionStatus(executionId, 'running');
      socket.emit('execution:resumed', { executionId, nodeId, ok: true });
      io.emit('execution:status', { executionId, status: 'running' });
    });

    // Cancel execution. A run waiting at a gate fails there; one inside a
    // model call is only marked, since the call cannot be aborted yet.
    socket.on('execution:cancel', (executionId: string) => {
      gates.cancel(executionId, 'Cancelled by user');
      db.updateExecutionStatus(executionId, 'error', 'Cancelled by user', Date.now());
      io.emit('execution:cancelled', { executionId });
    });

    // Cursor position for collaboration
    socket.on('cursor:move', (data: {
      workflowId: string;
      x: number;
      y: number;
    }) => {
      socket.to(`workflow:${data.workflowId}`).emit('cursor:update', {
        socketId: socket.id,
        x: data.x,
        y: data.y
      });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });
}
