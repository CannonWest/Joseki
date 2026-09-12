import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';
import { previewOf, resolveFormat } from '../output/format';

const OutputNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates } = useExecutionStore();
  const nodeState = nodeStates.get(id);
  const result = nodeState?.status === 'success' ? nodeState.trace : undefined;

  const getStatusColor = () => {
    if (!nodeState) return 'border-slate-700';
    switch (nodeState.status) {
      case 'running': return 'border-blue-500 ring-2 ring-blue-500/30';
      case 'success': return 'border-green-500';
      case 'error': return 'border-red-500';
      case 'skipped': return 'border-slate-800 opacity-50';
      default: return 'border-slate-700';
    }
  };

  return (
    <div className={`
      w-48 bg-slate-800 rounded-lg border-2 ${getStatusColor()}
      ${selected ? 'ring-2 ring-blue-400' : ''}
      transition-all duration-200
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-slate-600 border-2 border-slate-800"
      />

      <div className={`px-3 py-2 ${result ? 'border-b border-slate-700' : ''}`}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-slate-600 rounded flex items-center justify-center text-xs">
            ✓
          </div>
          <span className="font-medium text-slate-200 text-sm">
            {data.label}
          </span>
        </div>
      </div>

      {/* What reached this node on the last run; the panel has the whole thing */}
      {result && (
        <div className="px-3 py-2">
          <div className="text-xs text-slate-300 font-mono line-clamp-3 break-words">
            {previewOf(result.output) || <span className="italic text-slate-500">empty</span>}
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            {resolveFormat(result.output, data.config?.format)} · click to view
          </div>
        </div>
      )}
    </div>
  );
});

export { OutputNode };
