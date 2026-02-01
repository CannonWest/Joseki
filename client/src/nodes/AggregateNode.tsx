import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';

const AggregateNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates } = useExecutionStore();
  const nodeState = nodeStates.get(id);

  const getStatusColor = () => {
    if (!nodeState) return 'border-slate-700';
    switch (nodeState.status) {
      case 'running': return 'border-blue-500';
      case 'success': return 'border-green-500';
      case 'error': return 'border-red-500';
      default: return 'border-slate-700';
    }
  };

  const strategies: Record<string, string> = {
    concat: 'Concatenate',
    vote: 'Voting',
    merge: 'Merge'
  };

  return (
    <div className={`
      w-48 bg-slate-800 rounded-lg border-2 ${getStatusColor()} 
      ${selected ? 'ring-2 ring-blue-400' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-emerald-600 border-2 border-slate-800"
        style={{ left: '30%' }}
      />
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-emerald-600 border-2 border-slate-800"
        style={{ left: '70%' }}
      />
      
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-emerald-600 rounded flex items-center justify-center text-xs">
            ∑
          </div>
          <span className="font-medium text-slate-200 text-sm">
            {data.label}
          </span>
        </div>
      </div>

      <div className="p-3">
        <div className="text-xs text-slate-500">
          Strategy: {strategies[data.config?.strategy] || 'Concatenate'}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 bg-emerald-600 border-2 border-slate-800"
      />
    </div>
  );
});

export { AggregateNode };
