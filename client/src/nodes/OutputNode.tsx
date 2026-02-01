import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

const OutputNode = memo(({ data, selected }: NodeProps) => {
  return (
    <div className={`
      w-40 bg-slate-800 rounded-lg border-2 border-slate-700 
      ${selected ? 'ring-2 ring-blue-400' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-slate-600 border-2 border-slate-800"
      />
      
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-slate-600 rounded flex items-center justify-center text-xs">
            ✓
          </div>
          <span className="font-medium text-slate-200 text-sm">
            {data.label}
          </span>
        </div>
      </div>
    </div>
  );
});

export { OutputNode };
