import { useState, type KeyboardEvent } from 'react';
import type { Workflow } from '@joseki/shared';
import { EXAMPLES_FOLDER, ROOT_FOLDER, generateId, isWithinFolder } from '@joseki/shared';
import { saveTargets } from '../workflows/browse';
import { useWorkflowStore } from '../stores/workflowStore';

interface SaveWorkflowModalProps {
  /** The canvas as it is now. */
  workflow: Workflow;
  onClose: () => void;
  onSaved: (workflow: Workflow) => void;
}

const inputField =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500';

/**
 * Save asks for the two things a workflow is: its name and where it lives.
 *
 * A workflow that lives in Examples is saved as a copy — a new id, in a
 * folder outside Examples — because Examples holds what Joseki ships and Save
 * is for the workflows you keep. Anything else saves over itself, wherever it
 * is, the way Run and Export already do.
 */
export function SaveWorkflowModal({ workflow, onClose, onSaved }: SaveWorkflowModalProps) {
  const { folders, persistWorkflow } = useWorkflowStore();
  const targets = saveTargets(folders);

  const copying = isWithinFolder(workflow.folder, EXAMPLES_FOLDER);
  const [name, setName] = useState(workflow.name);
  const [folder, setFolder] = useState(() =>
    targets.some((target) => target.path === workflow.folder) ? workflow.folder : ROOT_FOLDER
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const canSave = trimmed !== '' && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await persistWorkflow({
        ...workflow,
        id: copying ? generateId() : workflow.id,
        name: trimmed,
        folder,
        updatedAt: Date.now()
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') void save();
    if (event.key === 'Escape') onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="save-workflow-modal"
    >
      <div
        className="w-[36rem] max-w-[90vw] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Save workflow"
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Save workflow</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          <label className="block">
            <span className="text-xs text-slate-400">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={onKeyDown}
              className={`mt-1 ${inputField}`}
              aria-label="Workflow name"
            />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Folder</span>
            <select
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className={`mt-1 ${inputField}`}
              aria-label="Folder"
            >
              {targets.map((target) => (
                <option key={target.path} value={target.path}>
                  {`${'  '.repeat(target.depth)}${target.depth ? '└ ' : ''}${target.name}`}
                </option>
              ))}
            </select>
          </label>

          {copying && (
            <p className="text-xs text-slate-500">
              This is an example. Saving makes a copy here and leaves Examples as it is.
            </p>
          )}

          {error && (
            <div role="alert" className="bg-red-900/30 text-red-200 rounded px-3 py-2 text-sm">
              {error}
            </div>
          )}
        </div>

        <div className="h-14 border-t border-slate-800 flex items-center justify-end gap-2 px-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
