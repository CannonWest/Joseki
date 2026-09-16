import type { Folder, FolderEntry, WorkflowSummary } from '@joseki/shared';
import {
  EXAMPLES_FOLDER,
  ROOT_FOLDER,
  SHIPPED_EXAMPLE_IDS,
  folderName,
  folderSegments,
  isWithinFolder
} from '@joseki/shared';

/**
 * What the Open dialog says about the things it lists. Pure, so the words a
 * row shows and the warning a delete puts up can be checked without a DOM.
 */

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** `7 nodes · 10 runs`, or `never run` for one that has not been. */
export function describeWorkflow(workflow: Pick<WorkflowSummary, 'nodeCount' | 'runCount'>): string {
  const runs = workflow.runCount ? count(workflow.runCount, 'run') : 'never run';
  return `${count(workflow.nodeCount, 'node')} · ${runs}`;
}

/** `2 workflows`, `3 workflows in 2 folders`, `1 folder`, or `empty`. */
export function describeFolder(folder: Pick<FolderEntry, 'workflowCount' | 'folderCount'>): string {
  if (!folder.workflowCount && !folder.folderCount) return 'empty';
  if (!folder.folderCount) return count(folder.workflowCount, 'workflow');
  if (!folder.workflowCount) return count(folder.folderCount, 'folder');
  return `${count(folder.workflowCount, 'workflow')} in ${count(folder.folderCount, 'folder')}`;
}

/** The question a delete asks. A workflow's runs go with it, and that is worth saying when there are any. */
export function deleteWorkflowWarning(workflow: Pick<WorkflowSummary, 'name' | 'runCount'>): string {
  if (!workflow.runCount) return `Delete "${workflow.name}"?`;
  const verb = workflow.runCount === 1 ? 'goes' : 'go';
  return `Delete "${workflow.name}"? Its ${count(workflow.runCount, 'run')} ${verb} with it.`;
}

/** The question a folder delete asks — what it holds, since all of it goes. */
export function deleteFolderWarning(folder: Pick<FolderEntry, 'name' | 'workflowCount' | 'folderCount'>): string {
  if (!folder.workflowCount && !folder.folderCount) return `Delete "${folder.name}"?`;
  const held = describeFolder(folder);
  const runs = folder.workflowCount ? ' Their runs go too.' : '';
  return `Delete "${folder.name}" and the ${held} in it?${runs}`;
}

export interface MoveTarget {
  path: string;
  name: string;
  /** How far in to indent it: the root is 0. */
  depth: number;
  /** Where it already is, or somewhere a folder cannot go: inside itself. */
  disabled: boolean;
}

/**
 * Every place a thing could be moved to: the root, then every folder in
 * path order, indented by depth. The folder it is in now is offered but
 * disabled, so the list reads as the whole tree; a folder being moved
 * cannot go into itself or anything under it.
 */
export function moveTargets(
  folders: Folder[],
  options: { currentFolder: string; movingFolder?: string }
): MoveTarget[] {
  const all = [ROOT_FOLDER, ...folders.map((folder) => folder.path).sort()];
  return all.map((path) => ({
    path,
    name: path === ROOT_FOLDER ? 'Workflows' : folderName(path),
    depth: folderSegments(path).length,
    disabled:
      path === options.currentFolder ||
      (options.movingFolder !== undefined && isWithinFolder(path, options.movingFolder))
  }));
}

/** The shipped examples that are not among the stored workflows — what Restore would bring back. */
export function missingExamples(workflows: Array<{ id: string }>): string[] {
  const present = new Set(workflows.map((workflow) => workflow.id));
  return SHIPPED_EXAMPLE_IDS.filter((id) => !present.has(id));
}

/** A place a workflow being saved may go. */
export interface SaveTarget {
  path: string;
  name: string;
  /** How far in to indent it: the root is 0. */
  depth: number;
}

/**
 * Where a workflow being saved may go: the root, then every folder outside
 * Examples, indented by depth. Examples is refused rather than listed — it
 * holds what Joseki ships, and Save is for the workflows you keep.
 */
export function saveTargets(folders: Folder[]): SaveTarget[] {
  return [ROOT_FOLDER, ...folders.map((folder) => folder.path).sort()]
    .filter((path) => !isWithinFolder(path, EXAMPLES_FOLDER))
    .map((path) => ({
      path,
      name: path === ROOT_FOLDER ? 'Top level' : folderName(path),
      depth: folderSegments(path).length
    }));
}
