import React from 'react';

interface ToolbarProps {
  onRun: () => void;
  isRunning: boolean;
  isConnected: boolean;
  onToggleChat: () => void;
  showChat: boolean;
  onOpenStepflow?: () => void;
}

export function Toolbar({ 
  onRun, 
  isRunning, 
  isConnected, 
  onToggleChat,
  showChat,
  onOpenStepflow
}: ToolbarProps) {
  return (
    <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 gap-4">
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
        <span className="text-sm text-slate-400">MaestroAI</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-xs text-slate-500">
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <div className="h-6 w-px bg-slate-800" />

      <button
        onClick={onToggleChat}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          showChat 
            ? 'bg-blue-600 text-white' 
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
        }`}
      >
        Chat
      </button>

      {onOpenStepflow && (
        <button
          onClick={onOpenStepflow}
          className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors flex items-center gap-1"
          title="Export/Import Stepflow workflows"
        >
          <span>⚡</span>
          Stepflow
        </button>
      )}

      <button
        onClick={onRun}
        disabled={isRunning}
        className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
      >
        {isRunning ? (
          <>
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Running...
          </>
        ) : (
          <>
            ▶ Run
          </>
        )}
      </button>
    </div>
  );
}
