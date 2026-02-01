import React from 'react';

interface NodeType {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: string;
}

const nodeTypes: NodeType[] = [
  {
    type: 'input',
    label: 'Input',
    description: 'Workflow input',
    color: 'bg-slate-600',
    icon: '→'
  },
  {
    type: 'prompt',
    label: 'Prompt',
    description: 'AI prompt node',
    color: 'bg-blue-600',
    icon: '🤖'
  },
  {
    type: 'branch',
    label: 'Branch',
    description: 'Conditional logic',
    color: 'bg-amber-600',
    icon: '↔'
  },
  {
    type: 'aggregate',
    label: 'Aggregate',
    description: 'Combine outputs',
    color: 'bg-emerald-600',
    icon: '∑'
  },
  {
    type: 'human_gate',
    label: 'Human Gate',
    description: 'Pause for approval',
    color: 'bg-purple-600',
    icon: '👤'
  },
  {
    type: 'model_compare',
    label: 'Compare',
    description: 'Multi-model test',
    color: 'bg-pink-600',
    icon: '⚖'
  },
  {
    type: 'output',
    label: 'Output',
    description: 'Workflow output',
    color: 'bg-slate-600',
    icon: '✓'
  }
];

export function NodePalette() {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-64 bg-slate-900 border-r border-slate-800 p-4 flex flex-col">
      <h2 className="text-lg font-semibold text-white mb-4">Nodes</h2>
      
      <div className="space-y-2">
        {nodeTypes.map((nodeType) => (
          <div
            key={nodeType.type}
            className="group cursor-grab active:cursor-grabbing"
            onDragStart={(e) => onDragStart(e, nodeType.type)}
            draggable
          >
            <div className="flex items-center gap-3 p-3 bg-slate-800/50 border border-slate-700 rounded-lg hover:border-slate-600 transition-colors">
              <div className={`w-8 h-8 ${nodeType.color} rounded-md flex items-center justify-center text-sm`}>
                {nodeType.icon}
              </div>
              <div>
                <div className="font-medium text-slate-200">{nodeType.label}</div>
                <div className="text-xs text-slate-500">{nodeType.description}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto pt-4 border-t border-slate-800">
        <div className="text-xs text-slate-500">
          <p className="mb-2">Drag nodes to canvas</p>
          <p>Connect by dragging handles</p>
        </div>
      </div>
    </div>
  );
}
