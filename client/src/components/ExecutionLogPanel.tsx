import { useRef, useEffect } from 'react';
import { useExecutionStore } from '../stores/executionStore';

interface ExecutionLogPanelProps {
  onClose: () => void;
}

// Node events and streamed prompt output for the run in progress
export function ExecutionLogPanel({ onClose }: ExecutionLogPanelProps) {
  const { logs, nodeStates } = useExecutionStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="w-96 h-full bg-slate-900 border-l border-slate-800 flex flex-col overflow-hidden">
      <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
        <h3 className="font-semibold text-slate-200">Execution Log</h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {logs.length === 0 ? (
          <div className="text-center text-slate-500 py-8">
            <p>Run a workflow to see execution logs</p>
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={`text-sm p-2 rounded ${
                log.type === 'error' ? 'bg-red-900/30 text-red-300' :
                log.type === 'success' ? 'bg-green-900/30 text-green-300' :
                'bg-slate-800/50 text-slate-300'
              }`}
            >
              <span className="text-xs opacity-60">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <p>{log.message}</p>
            </div>
          ))
        )}

        {/* Streaming outputs */}
        {Array.from(nodeStates.entries()).map(([nodeId, state]) => (
          state.streamingContent && (
            <div key={nodeId} className="bg-blue-900/20 border border-blue-800/50 rounded p-3">
              <div className="text-xs text-blue-400 mb-1">Node {nodeId} (streaming)</div>
              <div className="text-sm text-slate-200 whitespace-pre-wrap">
                {state.streamingContent}
              </div>
            </div>
          )
        ))}

        <div ref={scrollRef} />
      </div>
    </div>
  );
}
