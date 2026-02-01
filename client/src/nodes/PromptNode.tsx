import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';

const PromptNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates } = useExecutionStore();
  const nodeState = nodeStates.get(id);
  
  const config = data.config || {};
  const tokenEstimate = Math.ceil((config.systemPrompt?.length + config.userPrompt?.length) / 4);
  
  const getStatusColor = () => {
    if (!nodeState) return 'border-slate-700';
    switch (nodeState.status) {
      case 'running': return 'border-blue-500 ring-2 ring-blue-500/30';
      case 'success': return 'border-green-500';
      case 'error': return 'border-red-500';
      case 'paused': return 'border-purple-500';
      default: return 'border-slate-700';
    }
  };

  return (
    <div className={`
      w-64 bg-slate-800 rounded-lg border-2 ${getStatusColor()} 
      ${selected ? 'ring-2 ring-blue-400' : ''}
      transition-all duration-200
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-slate-600 border-2 border-slate-800"
      />
      
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-xs">
            🤖
          </div>
          <span className="font-medium text-slate-200 text-sm truncate">
            {data.label}
          </span>
        </div>
        {nodeState?.status === 'running' && (
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Model</span>
          <span className="text-slate-300 font-mono">{config.model || 'gpt-4'}</span>
        </div>
        
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Temperature</span>
          <span className="text-slate-300">{config.temperature || 0.7}</span>
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Tokens</span>
          <span className="text-slate-300 font-mono">~{tokenEstimate.toLocaleString()}</span>
        </div>

        {nodeState?.trace && (
          <>
            <div className="h-px bg-slate-700 my-2" />
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Cost</span>
              <span className="text-green-400">${nodeState.trace.cost.toFixed(4)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Latency</span>
              <span className="text-slate-300">{nodeState.trace.latencyMs}ms</span>
            </div>
          </>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 bg-slate-600 border-2 border-slate-800"
      />
    </div>
  );
});

export { PromptNode };
