import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';

const ModelCompareNode = memo(({ id, data, selected }: NodeProps) => {
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

  const models = data.config?.models || ['gpt-4', 'claude-3-opus'];

  return (
    <div className={`
      w-56 bg-slate-800 rounded-lg border-2 ${getStatusColor()} 
      ${selected ? 'ring-2 ring-blue-400' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-pink-600 border-2 border-slate-800"
      />
      
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-pink-600 rounded flex items-center justify-center text-xs">
            ⚖
          </div>
          <span className="font-medium text-slate-200 text-sm">
            {data.label}
          </span>
        </div>
      </div>

      <div className="p-3">
        <div className="text-xs text-slate-500 mb-2">Comparing {models.length} models:</div>
        <div className="flex flex-wrap gap-1">
          {models.map((model: string) => (
            <span 
              key={model}
              className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-300"
            >
              {model}
            </span>
          ))}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 bg-pink-600 border-2 border-slate-800"
      />
    </div>
  );
});

export { ModelCompareNode };
