import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';

const HumanGateNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates } = useExecutionStore();
  const nodeState = nodeStates.get(id);

  const isPaused = nodeState?.status === 'paused';

  return (
    <div className={`
      w-48 bg-slate-800 rounded-lg border-2 
      ${isPaused ? 'border-purple-500 ring-2 ring-purple-500/30' : 'border-slate-700'}
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

      <div className="p-3">
        <div className="text-xs text-slate-500 mb-2">
          {data.config?.instructions || 'Waiting for approval...'}
        </div>
        {isPaused && (
          <button className="w-full px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded transition-colors">
            Resume
          </button>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 bg-purple-600 border-2 border-slate-800"
      />
    </div>
  );
});

export { HumanGateNode };
