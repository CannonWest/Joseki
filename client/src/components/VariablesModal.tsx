import { useState } from 'react';
import { variableNameError } from '@joseki/shared';

interface VariablesModalProps {
  variables: Record<string, unknown>;
  onClose: () => void;
  onSave: (variables: Record<string, unknown>) => void;
}

interface Row {
  name: string;
  /** What is in the box. Parsed on save; kept as text while editing so a half-typed number stays half-typed. */
  text: string;
}

/**
 * A value is read as JSON when it parses as one and as text when it does not,
 * so `0.7` is a number, `true` is a boolean and `dry` is the word. The badge
 * beside each row says which it landed on, because the difference is invisible
 * in the box and decides whether `vars.x > 0.5` compares numbers or characters.
 */
function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** The text a value is edited and shown as: strings as themselves, the rest as JSON. */
export function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/** The type a value was read as — what the badge beside a row says. */
export function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return 'list';
  if (value === null) return 'null';
  return typeof value;
}

export function VariablesModal({ variables, onClose, onSave }: VariablesModalProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(variables).map(([name, value]) => ({ name, text: valueText(value) }))
  );

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const named = rows.filter((row) => row.name.trim() !== '');
  const duplicates = new Set(
    named.map((row) => row.name).filter((name, i, all) => all.indexOf(name) !== i)
  );
  const problems = named
    .map((row) => variableNameError(row.name))
    .filter((problem): problem is string => problem !== null);

  const handleSave = () => {
    const next: Record<string, unknown> = {};
    for (const row of named) next[row.name] = parseValue(row.text);
    onSave(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="variables-modal"
    >
      <div
        className="w-[40rem] max-w-[90vw] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Variables</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-slate-400">
            Values this workflow carries, the same for every node in a run. Read them in a prompt as{' '}
            <code className="text-slate-300">{'{{vars.name}}'}</code> and in a branch condition as{' '}
            <code className="text-slate-300">vars.name</code>. No node writes one.
          </p>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {rows.length === 0 && (
              <div className="text-xs text-slate-500 py-4 text-center">
                Nothing declared yet.
              </div>
            )}
            {rows.map((row, index) => {
              const problem = row.name.trim() === '' ? null : variableNameError(row.name);
              const duplicate = duplicates.has(row.name);
              return (
                <div key={index} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={row.name}
                      onChange={(e) => update(index, { name: e.target.value })}
                      placeholder="name"
                      spellCheck={false}
                      aria-label={`Variable ${index + 1} name`}
                      className={`w-44 bg-slate-800 border rounded px-2 py-1.5 text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 ${
                        problem || duplicate ? 'border-red-700' : 'border-slate-700'
                      }`}
                    />
                    <input
                      value={row.text}
                      onChange={(e) => update(index, { text: e.target.value })}
                      placeholder="value"
                      spellCheck={false}
                      aria-label={`Variable ${index + 1} value`}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    />
                    <span className="w-14 text-xs text-slate-500 text-right">
                      {typeLabel(parseValue(row.text))}
                    </span>
                    <button
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                      className="text-slate-500 hover:text-red-400 transition-colors px-1"
                      aria-label={`Remove variable ${index + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                  {problem && <div className="text-xs text-red-300 pl-1">{problem}</div>}
                  {!problem && duplicate && (
                    <div className="text-xs text-red-300 pl-1">
                      declared twice — the last one would win
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onClick={() => setRows((current) => [...current, { name: '', text: '' }])}
            className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors"
          >
            + Add variable
          </button>
        </div>

        <div className="h-14 border-t border-slate-800 flex items-center justify-end gap-2 px-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={problems.length > 0 || duplicates.size > 0}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
