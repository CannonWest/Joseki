import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useExecutionStore } from '../stores/executionStore';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { 
    setNodeStatus, 
    appendStreamToken, 
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
      addLog(`Node ${data.nodeId} started`, 'info');
    });

    socket.on('execution:nodeComplete', (data) => {
      setNodeStatus(data.nodeId, data.trace.status, data.trace);
      addLog(
        `Node ${data.nodeId} completed: ${data.trace.status}`,
        data.trace.status === 'success' ? 'success' : 'error'
      );
    });

    socket.on('execution:token', (data) => {
      appendStreamToken(data.nodeId, data.token);
    });

    socket.on('execution:complete', () => {
      endExecution();
      addLog('Execution completed', 'success');
    });

    socket.on('execution:error', (data) => {
      addLog(`Execution error: ${data.error}`, 'error');
      endExecution();
    });

    return () => {
      socket.disconnect();
    };
  }, [setNodeStatus, appendStreamToken, addLog, endExecution]);

  const subscribeToWorkflow = useCallback((workflowId: string) => {
    socketRef.current?.emit('subscribe:workflow', workflowId);
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    subscribeToWorkflow
  };
}
