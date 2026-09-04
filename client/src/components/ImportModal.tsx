import { useState } from 'react';
import type { Workflow, WorkflowValidation } from '@maestroai/shared';
import { useWorkflowStore } from '../stores/workflowStore';

interface ImportModalProps {
  onClose: () => void;
  onImported: (workflow: Workflow, validation: WorkflowValidation) => void;
}

export function ImportModal({ onClose, onImported }: ImportModalProps) {
  const { importWorkflow } = useWorkflowStore();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setText(await file.text());
  };

  const handleImport = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    try {
      const { workflow, validation } = await importWorkflow(parsed);
      onImported(workflow, validation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="import-modal"
    >
      <div
        className="w-[36rem] max-w-[90vw] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Import workflow</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3">
          <label className="block">
            <span className="text-xs text-slate-400">Choose a file exported from MaestroAI</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => handleFile(e.target.files?.[0])}
              className="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
            />
          </label>

          <div className="text-xs text-slate-500 text-center">or paste its JSON</div>

          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
              setError(null);
            }}
            spellCheck={false}
            placeholder='{"workflow": {"name": "...", "nodes": [...], "edges": [...]}}'
            className="w-full h-48 bg-slate-800 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />

          {fileName && <div className="text-xs text-slate-400">Loaded {fileName}</div>}
          {error && (
            <div role="alert" className="bg-red-900/30 text-red-200 rounded px-3 py-2 text-sm">
              {error}
            </div>
          )}
        </div>

        <div className="h-14 border-t border-slate-800 flex items-center justify-end gap-2 px-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors">
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={busy || text.trim() === ''}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
