import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ExecutionPausedEvent, ExecutionTrace, GateDecision } from '@joseki/shared';
import { traceLine, traceTone } from '../runs/format';
import { useExecutionStore } from '../stores/executionStore';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const {
    setNodeStatus,
    appendStreamToken,
    setPendingGate,
    addLog,
    endExecution
  } = useExecutionStore();

  useEffect(() => {
    const socket = io(import.meta.env.VITE_WS_URL || 'ws://localhost:3001');
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('Socket connected');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Socket disconnected');
    });

    socket.on('execution:nodeStart', (data) => {
      setNodeStatus(data.nodeId, 'running');
      addLog(`${data.nodeId} started`, 'info');
    });

    // A node that failed and is about to try again reports the failure here,
    // then starts over — so the log carries the whole attempt sequence, and
    // reads the same as the one a reopened run is rebuilt from.
    socket.on('execution:nodeComplete', (data: { nodeId: string; trace: ExecutionTrace }) => {
      setNodeStatus(data.nodeId, data.trace.status, data.trace);
      addLog(traceLine(data.nodeId, data.trace), traceTone(data.trace));
    });

    socket.on('execution:token', (data) => {
      appendStreamToken(data.nodeId, data.token);
    });

    socket.on('execution:paused', (event: ExecutionPausedEvent) => {
      setNodeStatus(event.nodeId, 'paused');
      setPendingGate(event);
      addLog(
        `Waiting at ${event.nodeId} for a decision (sent back ${event.revision} of ${event.maxRevisions} times so far)`,
        'info'
      );
    });

    socket.on('execution:resumed', (data: { nodeId: string; ok: boolean; error?: string }) => {
      if (data.ok) {
        setPendingGate(null);
      } else {
        addLog(`Could not resume at ${data.nodeId}: ${data.error}`, 'error');
      }
    });

    socket.on('execution:complete', () => {
      endExecution('success');
    });

    socket.on('execution:error', (data) => {
      addLog(`Execution error: ${data.error}`, 'error');
      endExecution('error');
    });

    return () => {
      socket.disconnect();
    };
  }, [setNodeStatus, appendStreamToken, setPendingGate, addLog, endExecution]);

  const subscribeToWorkflow = useCallback((workflowId: string) => {
    socketRef.current?.emit('subscribe:workflow', workflowId);
  }, []);

  /** Deliver the reviewer's decision to the gate the run is waiting at. */
  const resumeGate = useCallback((executionId: string, nodeId: string, decision: GateDecision) => {
    socketRef.current?.emit('execution:resume', { executionId, nodeId, decision });
  }, []);

  const cancelExecution = useCallback((executionId: string) => {
    socketRef.current?.emit('execution:cancel', executionId);
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    subscribeToWorkflow,
    resumeGate,
    cancelExecution
  };
}
