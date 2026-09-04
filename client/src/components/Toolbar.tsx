interface ToolbarProps {
  onRun: () => void;
  isRunning: boolean;
  isConnected: boolean;
  onToggleLog: () => void;
  showLog: boolean;
  onOpenChat: () => void;
  onValidate: () => void;
  onExport: () => void;
  onImport: () => void;
}

const secondaryButton =
  'px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors';

export function Toolbar({
  onRun,
  isRunning,
  isConnected,
  onToggleLog,
  showLog,
  onOpenChat,
  onValidate,
  onExport,
  onImport
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

      <button onClick={onValidate} className={secondaryButton} title="Check the workflow for problems">
        Validate
      </button>
      <button onClick={onExport} className={secondaryButton} title="Save and download this workflow as JSON">
        Export
      </button>
      <button onClick={onImport} className={secondaryButton} title="Load a workflow from a JSON file">
        Import
      </button>

      <div className="h-6 w-px bg-slate-800" />

      <button onClick={onOpenChat} className={secondaryButton} title="Chat with any model on OpenRouter">
        Chat
      </button>

      <button
        onClick={onToggleLog}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          showLog
            ? 'bg-blue-600 text-white'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
        }`}
        title="Show the execution log"
      >
        Log
      </button>

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
