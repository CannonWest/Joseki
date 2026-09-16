import { valueText, typeLabel } from './VariablesModal';

interface VariablesPanelProps {
  variables: Record<string, unknown>;
  onEdit: () => void;
}

/**
 * The workflow's declared values, kept where the canvas can see them: a card
 * above the minimap that says what a run will read. Editing stays in the
 * modal — this is the reminder, and the way back in.
 */
export function VariablesPanel({ variables, onEdit }: VariablesPanelProps) {
  const rows = Object.entries(variables);
  return (
    <div
      className="absolute right-4 bottom-44 z-10 w-56 bg-slate-900/95 border border-slate-700 rounded-lg shadow-lg"
      data-testid="variables-panel"
    >
      <div className="flex items-center justify-between pl-3 pr-2 py-1.5 border-b border-slate-800">
        <span className="text-xs font-semibold text-slate-300">
          Variables
          {rows.length > 0 && <span className="ml-1.5 text-slate-500">{rows.length}</span>}
        </span>
        <button
          onClick={onEdit}
          className="text-xs text-slate-400 hover:text-white transition-colors"
          title="Declare values every node in the run can read"
        >
          Edit
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-slate-500">None declared</p>
      ) : (
        <ul className="max-h-40 overflow-y-auto py-1">
          {rows.map(([name, value]) => (
            <li
              key={name}
              className="px-3 py-0.5 flex items-baseline gap-2"
              title={`${name} = ${valueText(value)} (${typeLabel(value)})`}
            >
              <span className="text-xs font-mono text-slate-200 truncate">{name}</span>
              <span className="ml-auto max-w-[9rem] text-[11px] text-slate-500 truncate">
                {valueText(value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
