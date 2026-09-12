import { useState } from 'react';

export interface RunInput {
  id: string;
  label: string;
  inputType?: string;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
}

interface RunInputsModalProps {
  inputs: RunInput[];
  onRun: (values: Record<string, unknown>) => void;
  onClose: () => void;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Turn the typed text into what the input node's type says it is. */
function coerce(text: string, inputType?: string): unknown {
  if (text === '') return '';
  switch (inputType) {
    case 'number': {
      const n = Number(text);
      return Number.isNaN(n) ? text : n;
    }
    case 'boolean':
      return text.trim().toLowerCase() === 'true';
    case 'json':
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    default:
      return text;
  }
}

/** Asks for each input node's value before a run; Default Value prefills it. */
export function RunInputsModal({ inputs, onRun, onClose }: RunInputsModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((input) => [input.id, asText(input.defaultValue)]))
  );

  const missing = inputs.filter((input) => input.required && !values[input.id]?.trim());

  const run = () => {
    if (missing.length) return;
    onRun(Object.fromEntries(inputs.map((input) => [input.id, coerce(values[input.id] ?? '', input.inputType)])));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="run-inputs-modal"
    >
      <div
        className="w-[36rem] max-w-[90vw] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Inputs for this run</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {inputs.map((input) => (
            <label key={input.id} className="block">
              <span className="text-xs text-slate-400">
                {input.label}
                {input.required && <span className="text-red-400 ml-1">*</span>}
                {input.inputType && input.inputType !== 'text' && (
                  <span className="text-slate-600 ml-2">{input.inputType}</span>
                )}
              </span>
              {input.description && (
                <span className="block text-xs text-slate-500">{input.description}</span>
              )}
              <textarea
                value={values[input.id] ?? ''}
                onChange={(e) => setValues({ ...values, [input.id]: e.target.value })}
                rows={input.inputType === 'text' || !input.inputType ? 6 : 2}
                className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono"
                autoFocus={input === inputs[0]}
              />
            </label>
          ))}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={run}
            disabled={missing.length > 0}
            title={missing.length ? `Required: ${missing.map((m) => m.label).join(', ')}` : undefined}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            ▶ Run
          </button>
        </div>
      </div>
    </div>
  );
}
