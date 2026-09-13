import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Folder, FolderEntry, FolderListing, Workflow, WorkflowSummary } from '@joseki/shared';
import {
  ROOT_FOLDER,
  breadcrumbs,
  childFolder,
  folderNameError,
  isWithinFolder,
  parentFolder
} from '@joseki/shared';
import * as api from '../workflows/api';
import {
  deleteFolderWarning,
  deleteWorkflowWarning,
  describeFolder,
  describeWorkflow,
  missingExamples,
  moveTargets
} from '../workflows/browse';
import { relativeTime } from './chat/format';
import { useWorkflowStore } from '../stores/workflowStore';

interface OpenWorkflowDialogProps {
  /** The folder to start in. The root when not given. */
  initialPath?: string;
  /**
   * The dialog is over the canvas, so the store's current workflow is open
   * there with edits of its own. Then a rename or move of that workflow —
   * or of a folder holding it — is written through to the store, so the
   * canvas's next save does not put it back; and neither it nor a folder
   * holding it can be deleted, since the next save would bring it back.
   */
  onCanvas?: boolean;
  onClose: () => void;
  /** A workflow was picked: the whole thing, fetched fresh. */
  onOpen: (workflow: Workflow) => void;
  /** Make a new workflow in the folder being looked at. */
  onNew: (folder: string) => void;
}

/** What one row is in the middle of, if anything. */
type RowMode =
  | { kind: 'rename'; row: string }
  | { kind: 'move'; row: string }
  | { kind: 'delete'; row: string }
  | { kind: 'new-folder' }
  | null;

const rowKey = (kind: 'folder' | 'workflow', id: string) => `${kind}:${id}`;

const actionButton = 'text-xs text-slate-400 hover:text-white transition-colors';
const smallButton =
  'px-2 py-1 text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 rounded transition-colors disabled:opacity-50';
const primarySmallButton =
  'px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded transition-colors';
const dangerSmallButton =
  'px-2 py-1 text-xs bg-red-600/80 hover:bg-red-500 disabled:bg-slate-700 text-white rounded transition-colors';
const inputField =
  'bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500';

/**
 * The workflow library, as a filesystem: folders to walk into, workflows
 * to open, and the things done to either — rename, move, delete — done in
 * the row itself, so nothing is asked in a second dialog. The Examples
 * folder holds what Joseki ships; everything made from the welcome screen
 * goes in the root.
 */
export function OpenWorkflowDialog({
  initialPath = ROOT_FOLDER,
  onCanvas = false,
  onClose,
  onOpen,
  onNew
}: OpenWorkflowDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<RowMode>(null);
  const { workflows, loadWorkflows, currentWorkflow, setCurrentWorkflow } = useWorkflowStore();

  // The workflow open on the canvas behind this dialog, if any.
  const open = onCanvas ? currentWorkflow : null;
  const holdsOpen = (folder: string) => open !== null && isWithinFolder(open.folder, folder);

  /** A rename or move of the open workflow, written through to the canvas's copy. */
  const syncOpen = (workflow: Workflow) => {
    const current = useWorkflowStore.getState().currentWorkflow;
    if (onCanvas && current && current.id === workflow.id) {
      setCurrentWorkflow({ ...current, name: workflow.name, folder: workflow.folder });
    }
  };

  /** A folder renamed or moved: the open workflow's path follows if it was inside. */
  const syncOpenFolder = (from: string, to: string) => {
    const current = useWorkflowStore.getState().currentWorkflow;
    if (onCanvas && current && isWithinFolder(current.folder, from)) {
      setCurrentWorkflow({ ...current, folder: to + current.folder.slice(from.length) });
    }
  };

  const refresh = useCallback(async (at: string) => {
    try {
      const [contents, all] = await Promise.all([api.listFolder(at), api.allFolders()]);
      setListing(contents);
      setFolders(all);
      setError(null);
    } catch (cause) {
      // A folder that has gone while it was open: go up rather than show nothing.
      if (at !== ROOT_FOLDER && cause instanceof Error && /No folder/.test(cause.message)) {
        setPath(parentFolder(at));
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setListing({ path: at, folders: [], workflows: [] });
    }
  }, []);

  useEffect(() => {
    setMode(null);
    void refresh(path);
  }, [path, refresh]);

  // Escape backs out of whatever a row is in the middle of, and with
  // nothing in progress closes the dialog.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (mode !== null) setMode(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  /** Runs a change, then reads the folder again and tells the store, whose counts the welcome screen shows. */
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode(null);
      await refresh(path);
      void loadWorkflows();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openWorkflow = async (summary: WorkflowSummary) => {
    setBusy(true);
    setError(null);
    try {
      onOpen(await api.getWorkflow(summary.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const missing = missingExamples(workflows);
  const crumbs = breadcrumbs(path);
  const empty = listing !== null && listing.folders.length === 0 && listing.workflows.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="open-workflow-dialog"
    >
      <div
        className="w-[44rem] max-w-[92vw] max-h-[80vh] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Open workflow"
      >
        <div className="h-12 shrink-0 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">Open workflow</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-800">
          <nav className="flex-1 min-w-0 flex items-center gap-1 text-sm" aria-label="Folder path">
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <span key={crumb.path} className="flex items-center gap-1 min-w-0">
                  {i > 0 && <span className="text-slate-600">›</span>}
                  {last ? (
                    <span className="text-slate-200 font-medium truncate" aria-current="location">
                      {crumb.name}
                    </span>
                  ) : (
                    <button
                      onClick={() => setPath(crumb.path)}
                      className="text-slate-400 hover:text-white transition-colors truncate"
                    >
                      {crumb.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          <button
            onClick={() => setMode({ kind: 'new-folder' })}
            disabled={busy || mode?.kind === 'new-folder'}
            className={smallButton}
            title="Make a folder here"
          >
            New folder
          </button>
          <button
            onClick={() => onNew(path)}
            disabled={busy}
            className={primarySmallButton}
            title={path ? `Start a new workflow in ${path}` : 'Start a new workflow'}
          >
            + New workflow
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {error && (
            <p role="alert" className="mx-1 mb-2 text-sm text-red-200 bg-red-900/30 rounded px-3 py-2">
              {error}
            </p>
          )}

          {mode?.kind === 'new-folder' && (
            <NewFolderRow
              parent={path}
              busy={busy}
              onCancel={() => setMode(null)}
              onCreate={(name) => change(() => api.createFolder(childFolder(path, name)))}
            />
          )}

          {listing === null && <p className="px-3 py-6 text-sm text-slate-500">Loading…</p>}

          {empty && mode?.kind !== 'new-folder' && (
            <p className="px-3 py-6 text-sm text-slate-500 text-center">
              Nothing here yet. Make a folder, start a workflow, or move one in.
            </p>
          )}

          {listing?.folders.map((folder) => (
            <FolderRow
              key={folder.path}
              folder={folder}
              mode={mode?.kind !== 'new-folder' && mode?.row === rowKey('folder', folder.path) ? mode.kind : null}
              busy={busy}
              targets={moveTargets(folders, { currentFolder: path, movingFolder: folder.path })}
              cannotDelete={holdsOpen(folder.path) ? 'The workflow on the canvas is in this folder' : null}
              onEnter={() => setPath(folder.path)}
              onMode={(kind) => setMode(kind ? { kind, row: rowKey('folder', folder.path) } : null)}
              onRename={(name) =>
                change(() =>
                  api.renameFolder(folder.path, childFolder(path, name)).then((moved) => syncOpenFolder(folder.path, moved.path))
                )
              }
              onMove={(to) =>
                change(() =>
                  api.renameFolder(folder.path, childFolder(to, folder.name)).then((moved) => syncOpenFolder(folder.path, moved.path))
                )
              }
              onDelete={() => change(() => api.deleteFolder(folder.path, true))}
            />
          ))}

          {listing?.workflows.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              mode={mode?.kind !== 'new-folder' && mode?.row === rowKey('workflow', workflow.id) ? mode.kind : null}
              busy={busy}
              targets={moveTargets(folders, { currentFolder: path })}
              isOpen={open?.id === workflow.id}
              cannotDelete={open?.id === workflow.id ? 'This workflow is open on the canvas' : null}
              onOpen={() => openWorkflow(workflow)}
              onMode={(kind) => setMode(kind ? { kind, row: rowKey('workflow', workflow.id) } : null)}
              onRename={(name) => change(() => api.renameWorkflow(workflow.id, name).then(syncOpen))}
              onMove={(to) => change(() => api.moveWorkflow(workflow.id, to).then(syncOpen))}
              onDelete={() => change(() => api.deleteWorkflow(workflow.id))}
            />
          ))}
        </div>

        <div className="h-12 shrink-0 border-t border-slate-800 flex items-center justify-between gap-4 px-4 text-[11px] text-slate-500">
          <span>
            {path === ROOT_FOLDER
              ? 'New workflows are saved here, at the top, unless you start one inside a folder.'
              : `A workflow started here is saved in ${path}.`}
          </span>
          {missing.length > 0 && (
            <button
              onClick={() => change(() => api.restoreExamples())}
              disabled={busy}
              className="text-slate-400 hover:text-white transition-colors whitespace-nowrap"
              title="Put back the shipped examples that are missing, in the Examples folder"
            >
              Restore {missing.length === 1 ? 'the missing example' : `${missing.length} missing examples`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== rows ====================

function NewFolderRow({
  parent,
  busy,
  onCancel,
  onCreate
}: {
  parent: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const problem = name === '' ? null : folderNameError(name);

  const submit = () => {
    if (name.trim() === '' || problem) return;
    onCreate(name.trim());
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800/60 border border-blue-700/60 mb-1">
      <span aria-hidden>📁</span>
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') onCancel();
        }}
        placeholder={parent ? `New folder in ${parent}` : 'New folder'}
        aria-label="Folder name"
        className={`${inputField} flex-1`}
      />
      {problem && <span className="text-[11px] text-amber-300">{problem}</span>}
      <button onClick={submit} disabled={busy || name.trim() === '' || problem !== null} className={primarySmallButton}>
        Create
      </button>
      <button onClick={onCancel} disabled={busy} className={smallButton}>
        Cancel
      </button>
    </div>
  );
}

interface RowActionsProps {
  mode: 'rename' | 'move' | 'delete' | null;
  busy: boolean;
  /** Why this row cannot be deleted, or null when it can. */
  cannotDelete: string | null;
  onMode: (kind: 'rename' | 'move' | 'delete' | null) => void;
}

/** Rename · Move · Delete, shown when the row is hovered or holds focus. */
function RowActions({ busy, cannotDelete, onMode }: Pick<RowActionsProps, 'busy' | 'cannotDelete' | 'onMode'>) {
  const stop = (event: React.MouseEvent, kind: 'rename' | 'move' | 'delete') => {
    event.stopPropagation();
    onMode(kind);
  };
  return (
    <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button onClick={(e) => stop(e, 'rename')} disabled={busy} className={actionButton}>
        Rename
      </button>
      <button onClick={(e) => stop(e, 'move')} disabled={busy} className={actionButton}>
        Move
      </button>
      <button
        onClick={(e) => stop(e, 'delete')}
        disabled={busy || cannotDelete !== null}
        title={cannotDelete ?? undefined}
        className="text-xs text-slate-400 hover:text-red-400 disabled:hover:text-slate-400 disabled:opacity-50 transition-colors"
      >
        Delete
      </button>
    </div>
  );
}

/** A name being edited in place: Enter keeps it, Escape or an empty name drops the edit. */
function RenameField({
  value,
  busy,
  validate,
  onCommit,
  onCancel
}: {
  value: string;
  busy: boolean;
  validate?: (name: string) => string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const problem = draft.trim() === '' || draft.trim() === value ? null : validate?.(draft.trim()) ?? null;

  const commit = () => {
    const next = draft.trim();
    if (next === '' || next === value || problem) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') onCancel();
  };

  return (
    <div className="flex-1 flex items-center gap-2 min-w-0">
      <input
        autoFocus
        value={draft}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        disabled={busy}
        aria-label="New name"
        className={`${inputField} flex-1 min-w-0`}
      />
      {problem && <span className="text-[11px] text-amber-300 whitespace-nowrap">{problem}</span>}
      <button onClick={(e) => { e.stopPropagation(); commit(); }} disabled={busy || problem !== null} className={primarySmallButton}>
        Save
      </button>
      <button onClick={(e) => { e.stopPropagation(); onCancel(); }} disabled={busy} className={smallButton}>
        Cancel
      </button>
    </div>
  );
}

/** A folder to move into, chosen from the whole tree. */
function MoveField({
  targets,
  busy,
  onMove,
  onCancel
}: {
  targets: ReturnType<typeof moveTargets>;
  busy: boolean;
  onMove: (path: string) => void;
  onCancel: () => void;
}) {
  const first = targets.find((target) => !target.disabled);
  const [choice, setChoice] = useState<string | null>(first ? first.path : null);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  return (
    <div className="flex-1 flex items-center gap-2 min-w-0" onClick={(event) => event.stopPropagation()}>
      <span className="text-xs text-slate-400 whitespace-nowrap">Move to</span>
      <select
        ref={selectRef}
        value={choice ?? ''}
        onChange={(event) => setChoice(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
        disabled={busy || first === undefined}
        aria-label="Move to folder"
        className={`${inputField} flex-1 min-w-0`}
      >
        {targets.map((target) => (
          <option key={target.path} value={target.path} disabled={target.disabled}>
            {`${'  '.repeat(target.depth)}${target.depth ? '└ ' : ''}${target.name}`}
          </option>
        ))}
      </select>
      <button
        onClick={() => choice !== null && onMove(choice)}
        disabled={busy || choice === null}
        className={primarySmallButton}
      >
        Move
      </button>
      <button onClick={onCancel} disabled={busy} className={smallButton}>
        Cancel
      </button>
    </div>
  );
}

/** The question, and the two ways out of it. */
function ConfirmField({
  question,
  busy,
  onConfirm,
  onCancel
}: {
  question: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex-1 flex items-center gap-2 min-w-0" onClick={(event) => event.stopPropagation()}>
      <span className="flex-1 text-sm text-red-200 min-w-0">{question}</span>
      <button
        onClick={onConfirm}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm();
        }}
        disabled={busy}
        className={dangerSmallButton}
        autoFocus
      >
        Delete
      </button>
      <button onClick={onCancel} disabled={busy} className={smallButton}>
        Cancel
      </button>
    </div>
  );
}

function FolderRow({
  folder,
  mode,
  busy,
  targets,
  cannotDelete,
  onEnter,
  onMode,
  onRename,
  onMove,
  onDelete
}: RowActionsProps & {
  folder: FolderEntry;
  targets: ReturnType<typeof moveTargets>;
  onEnter: () => void;
  onRename: (name: string) => void;
  onMove: (to: string) => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={mode ? -1 : 0}
      onClick={() => mode === null && onEnter()}
      onKeyDown={(event) => {
        if (mode === null && event.key === 'Enter') onEnter();
      }}
      data-testid="folder-row"
      className={`group flex items-center gap-3 px-3 py-2 rounded-md ${
        mode ? 'bg-slate-800/60' : 'hover:bg-slate-800/60 cursor-pointer'
      }`}
    >
      <span aria-hidden className="text-lg leading-none">📁</span>
      {mode === 'rename' ? (
        <RenameField
          value={folder.name}
          busy={busy}
          validate={folderNameError}
          onCommit={onRename}
          onCancel={() => onMode(null)}
        />
      ) : mode === 'move' ? (
        <MoveField targets={targets} busy={busy} onMove={onMove} onCancel={() => onMode(null)} />
      ) : mode === 'delete' ? (
        <ConfirmField question={deleteFolderWarning(folder)} busy={busy} onConfirm={onDelete} onCancel={() => onMode(null)} />
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-200 truncate">{folder.name}</div>
            <div className="text-[11px] text-slate-500">{describeFolder(folder)}</div>
          </div>
          <RowActions busy={busy} cannotDelete={cannotDelete} onMode={onMode} />
        </>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow,
  mode,
  busy,
  targets,
  isOpen,
  cannotDelete,
  onOpen,
  onMode,
  onRename,
  onMove,
  onDelete
}: RowActionsProps & {
  workflow: WorkflowSummary;
  targets: ReturnType<typeof moveTargets>;
  /** Open on the canvas behind the dialog right now. */
  isOpen: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onMove: (to: string) => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={mode ? -1 : 0}
      onClick={() => mode === null && !busy && onOpen()}
      onKeyDown={(event) => {
        if (mode === null && event.key === 'Enter') onOpen();
      }}
      data-testid="workflow-row"
      className={`group flex items-center gap-3 px-3 py-2 rounded-md ${
        mode ? 'bg-slate-800/60' : 'hover:bg-slate-800/60 cursor-pointer'
      }`}
    >
      <span aria-hidden className="w-[1.125rem] text-center text-slate-500 text-sm">▤</span>
      {mode === 'rename' ? (
        <RenameField value={workflow.name} busy={busy} onCommit={onRename} onCancel={() => onMode(null)} />
      ) : mode === 'move' ? (
        <MoveField targets={targets} busy={busy} onMove={onMove} onCancel={() => onMode(null)} />
      ) : mode === 'delete' ? (
        <ConfirmField question={deleteWorkflowWarning(workflow)} busy={busy} onConfirm={onDelete} onCancel={() => onMode(null)} />
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-200 truncate">
              {workflow.name}
              {isOpen && <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-400">on canvas</span>}
            </div>
            <div className="text-[11px] text-slate-500">
              {describeWorkflow(workflow)} · {relativeTime(workflow.updatedAt)}
            </div>
          </div>
          <RowActions busy={busy} cannotDelete={cannotDelete} onMode={onMode} />
        </>
      )}
    </div>
  );
}
