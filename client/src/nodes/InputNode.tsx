import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useExecutionStore } from '../stores/executionStore';
import { previewOf } from '../output/format';

const typeIcons: Record<string, string> = {
  text: '📝',
  number: '🔢',
  boolean: '☑️',
  json: '📋',
  chat: '💬'
};

const typeColors: Record<string, string> = {
  text: 'bg-blue-600',
  number: 'bg-emerald-600',
  boolean: 'bg-amber-600',
  json: 'bg-purple-600',
  chat: 'bg-pink-600'
};

const InputNode = memo(({ id, data, selected }: NodeProps) => {
  const { nodeStates } = useExecutionStore();
  const nodeState = nodeStates.get(id);

  const config = data.config || {};
  const inputType = config.inputType || 'text';
  const icon = typeIcons[inputType] || '→';
  const colorClass = typeColors[inputType] || 'bg-slate-600';

  const getStatusColor = () => {
    if (!nodeState) return 'border-slate-700';
    switch (nodeState.status) {
      case 'running': return 'border-blue-500 ring-2 ring-blue-500/30';
      case 'success': return 'border-green-500';
      case 'error': return 'border-red-500';
      case 'skipped': return 'border-slate-800 opacity-50';
      case 'paused': return 'border-purple-500';
      default: return 'border-slate-700';
    }
  };

  // What this input actually supplied on the run in view: an input node's
  // trace output IS the value the rest of the workflow ran on, so a reopened
  // run says what went into it, not just what it was configured to accept.
  const supplied = nodeState?.status === 'success' ? nodeState.trace : undefined;

  // The run that failed here failed for a reason worth reading — a missing
  // required value is the whole story of that run.
  const failure = nodeState?.status === 'error' ? nodeState.trace?.error : undefined;

  return (
    <div className={`
      w-48 bg-slate-800 rounded-lg border-2 ${getStatusColor()}
      ${selected ? 'ring-2 ring-blue-400' : ''}
      transition-all duration-200
    `}>
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 ${colorClass} rounded flex items-center justify-center text-xs`}>
            {icon}
          </div>
          <span className="font-medium text-slate-200 text-sm truncate">
            {data.label}
          </span>
        </div>
      </div>

      {/* Type indicator */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500 capitalize">{inputType}</span>
          {config.required && (
            <span className="text-xs text-red-400">*</span>
          )}
        </div>

        {supplied ? (
          <div className="mt-1">
            <div className="text-xs text-slate-300 font-mono line-clamp-2 break-words">
              {previewOf(supplied.output, 60) || <span className="italic text-slate-500">empty</span>}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">used this run</div>
          </div>
        ) : failure ? (
          <div className="mt-1 text-[11px] text-red-300 line-clamp-3 break-words">
            {failure}
          </div>
        ) : (
          config.defaultValue !== undefined && config.defaultValue !== '' && (
            <div className="mt-1 text-xs text-slate-400 truncate">
              Default: {previewOf(config.defaultValue, 20)}
            </div>
          )
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        id="output"
        className="w-3 h-3 bg-slate-600 border-2 border-slate-800"
      />
    </div>
  );
});

export { InputNode };
