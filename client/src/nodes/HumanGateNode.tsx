import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';

const HumanGateNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates, pendingGate } = useExecutionStore();
  const nodeState = nodeStates.get(id);

  const isPaused = nodeState?.status === 'paused';
  const waiting = isPaused && pendingGate?.nodeId === id ? pendingGate : null;

  const getStatusColor = () => {
    if (!nodeState) return 'border-slate-700';
    switch (nodeState.status) {
      case 'running': return 'border-blue-500 ring-2 ring-blue-500/30';
      case 'paused': return 'border-purple-500 ring-2 ring-purple-500/30';
      case 'success': return 'border-green-500';
      case 'error': return 'border-red-500';
      case 'skipped': return 'border-slate-800 opacity-50';
      default: return 'border-slate-700';
    }
  };

  return (
    <div className={`
      relative w-48 bg-slate-800 rounded-lg border-2 ${getStatusColor()}
      ${selected ? 'ring-2 ring-blue-400' : ''}
      transition-all duration-200
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-purple-600 border-2 border-slate-800"
      />

      <div className="px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-purple-600 rounded flex items-center justify-center text-xs">
            👤
          </div>
          <span className="font-medium text-slate-200 text-sm">
            {data.label}
          </span>
        </div>
      </div>

      <div className="p-3 pb-5">
        <div className="text-xs text-slate-500">
          {data.config?.instructions || 'Waiting for approval...'}
        </div>
        {waiting && (
          <div className="mt-2 text-xs text-purple-300">
            Waiting for your decision
            {waiting.revision > 0 && ` · sent back ${waiting.revision}/${waiting.maxRevisions}`}
          </div>
        )}
        {nodeState?.trace?.input?.decision && !isPaused && (
          <div className="mt-2 text-xs text-slate-400">
            {nodeState.trace.input.decision.verdict === 'pass' ? '✓ approved' : '↩ sent back'}
          </div>
        )}
      </div>

      {/* Two outputs: approve down the left, send back down the right */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="pass"
        className="w-3 h-3 bg-green-600 border-2 border-slate-800"
        style={{ left: '30%' }}
      />
      <span className="absolute bottom-1 text-[10px] text-green-400 -translate-x-1/2 pointer-events-none" style={{ left: '30%' }}>
        pass
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        id="fail"
        className="w-3 h-3 bg-red-600 border-2 border-slate-800"
        style={{ left: '70%' }}
      />
      <span className="absolute bottom-1 text-[10px] text-red-400 -translate-x-1/2 pointer-events-none" style={{ left: '70%' }}>
        fail
      </span>
    </div>
  );
});

export { HumanGateNode };
