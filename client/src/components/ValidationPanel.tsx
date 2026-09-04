import type { WorkflowValidation } from '@maestroai/shared';

interface ValidationPanelProps {
  result: WorkflowValidation;
  onClose: () => void;
}

export function ValidationPanel({ result, onClose }: ValidationPanelProps) {
  const { errors, warnings } = result;
  const title =
    errors.length > 0
      ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
      : warnings.length > 0
        ? 'Workflow is runnable'
        : 'Workflow is valid';

  return (
    <div
      role="status"
      data-testid="validation-panel"
      className={`fixed top-16 right-4 z-50 w-96 max-h-[70vh] flex flex-col bg-slate-900 border rounded-lg shadow-xl ${
        errors.length > 0 ? 'border-red-800' : warnings.length > 0 ? 'border-amber-800' : 'border-emerald-800'
      }`}
    >
      <div className="h-11 border-b border-slate-800 flex items-center justify-between px-4">
        <div className="flex items-baseline gap-2">
          <h3 className="font-semibold text-slate-200">{title}</h3>
          {warnings.length > 0 && (
            <span className="text-xs text-amber-400">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        {errors.length === 0 && warnings.length === 0 && (
          <p className="text-emerald-300">No problems found.</p>
        )}
        {errors.length > 0 && (
          <ul className="space-y-1">
            {errors.map((message, i) => (
              <li key={`e-${i}`} className="bg-red-900/30 text-red-200 rounded px-2 py-1">
                {message}
              </li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((message, i) => (
              <li key={`w-${i}`} className="bg-amber-900/30 text-amber-200 rounded px-2 py-1">
                {message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
