import React from 'react';

interface NodeType {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: string;
}

interface NodePaletteProps {
  onOpen: () => void;
  onSave: () => void;
  onClear: () => void;
  /** False while a run is in flight — the run owns the canvas until it ends. */
  canClear: boolean;
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
    type: 'transform',
    label: 'Transform',
    description: 'Compute without a model',
    color: 'bg-cyan-600',
    icon: 'ƒ'
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
    type: 'output',
    label: 'Output',
    description: 'Workflow output',
    color: 'bg-slate-600',
    icon: '✓'
  }
];

export function NodePalette({ onOpen, onSave, onClear, canClear }: NodePaletteProps) {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-64 bg-slate-900 border-r border-slate-800 p-4 flex flex-col overflow-y-auto">
      <div className="mb-4 pb-4 border-b border-slate-800 space-y-2">
        <button
          onClick={onOpen}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors"
          title="Open another workflow, or arrange the folders"
        >
          <span aria-hidden>📁</span>
          Open Workflows
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onSave}
            className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors"
            title="Name this workflow and save it to the list"
          >
            Save
          </button>
          <button
            onClick={onClear}
            disabled={!canClear}
            className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-red-600/80 hover:text-white disabled:opacity-50 disabled:hover:bg-slate-800 disabled:hover:text-slate-300 rounded-md transition-colors"
            title={canClear ? 'Empty the canvas and start over' : 'Stop the run first'}
          >
            Clear
          </button>
        </div>
      </div>

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
          <p>Drag nodes to canvas</p>
        </div>
      </div>
    </div>
  );
}
