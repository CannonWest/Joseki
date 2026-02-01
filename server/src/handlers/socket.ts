import { Server, Socket } from 'socket.io';
import { Database } from '../db/database';
import { WorkflowExecutor } from '../engine/executor';

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
    }) => {
      const { workflowId, executionId, startNodeId, context = {} } = data;
      
      const workflow = db.getWorkflow(workflowId);
      if (!workflow) {
        socket.emit('execution:error', { executionId, error: 'Workflow not found' });
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

      const executor = new WorkflowExecutor(db);

      try {
        await executor.execute(workflow, executionId, {
          startNodeId,
          context,
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

    // Pause execution (for human gate)
    socket.on('execution:pause', (data: { executionId: string; nodeId: string }) => {
      const { executionId, nodeId } = data;
      db.updateExecutionStatus(executionId, 'paused');
      io.emit('execution:paused', { executionId, nodeId });
    });

    // Resume execution (after human gate)
    socket.on('execution:resume', async (data: {
      executionId: string;
      nodeId: string;
      input?: any;
    }) => {
      const { executionId, nodeId, input } = data;
      
      // Resume execution with provided input
      socket.emit('execution:resumed', { executionId, nodeId });
      io.emit('execution:status', { executionId, status: 'running' });
    });

    // Cancel execution
    socket.on('execution:cancel', (executionId: string) => {
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
