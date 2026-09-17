import { useRef, useEffect } from 'react';
import { useExecutionStore } from '../stores/executionStore';
import { useResizableWidth } from '../hooks/useResizableWidth';
import { Reasoning } from './chat/MessageBubble';

interface ExecutionLogPanelProps {
  onClose: () => void;
}

/** The 24rem the panel used to be fixed at, and how far it may now be taken. */
const DEFAULT_WIDTH = 384;
const WIDTH_BOUNDS = { min: 280, max: 900 };
const WIDTH_KEY = 'joseki.executionLog.width';

// Node events and streamed prompt output for the run in progress
export function ExecutionLogPanel({ onClose }: ExecutionLogPanelProps) {
  const { logs, nodeStates } = useExecutionStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, resizing, handleProps } = useResizableWidth(WIDTH_KEY, DEFAULT_WIDTH, WIDTH_BOUNDS);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div
      style={{ width }}
      className={`relative h-full shrink-0 bg-slate-900 border-l border-slate-800 flex flex-col overflow-hidden ${
        resizing ? 'select-none' : ''
      }`}
    >
      {/* A condition or a streamed reply can be a good deal wider than the
          column it arrives in. Pull this edge left to read it. */}
      <div
        {...handleProps}
        title="Drag to resize"
        className={`absolute left-0 top-0 h-full w-1.5 z-10 cursor-col-resize touch-none transition-colors ${
          resizing ? 'bg-blue-500/70' : 'hover:bg-blue-500/40'
        }`}
      />

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
              {/* A branch line carries its condition, which can be longer
                  than the column is wide. */}
              <p className="break-words">{log.message}</p>
            </div>
          ))
        )}

        {/* Streaming outputs */}
        {Array.from(nodeStates.entries()).map(([nodeId, state]) => (
          (state.streamingContent || state.streamingReasoning) && (
            <div key={nodeId} className="bg-blue-900/20 border border-blue-800/50 rounded p-3">
              <div className="text-xs text-blue-400 mb-1">Node {nodeId} (streaming)</div>
              {state.streamingReasoning && (
                <Reasoning text={state.streamingReasoning} live={state.status === 'running'} />
              )}
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
