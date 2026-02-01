import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

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

const InputNode = memo(({ data, selected }: NodeProps) => {
  const config = data.config || {};
  const inputType = config.inputType || 'text';
  const icon = typeIcons[inputType] || '→';
  const colorClass = typeColors[inputType] || 'bg-slate-600';
  
  return (
    <div className={`
      w-48 bg-slate-800 rounded-lg border-2 border-slate-700 
      ${selected ? 'ring-2 ring-blue-400' : ''}
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
        
        {/* Default value preview */}
        {config.defaultValue && (
          <div className="mt-1 text-xs text-slate-400 truncate">
            Default: {typeof config.defaultValue === 'string' 
              ? config.defaultValue.slice(0, 20) + (config.defaultValue.length > 20 ? '...' : '')
              : JSON.stringify(config.defaultValue).slice(0, 20)}
          </div>
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
