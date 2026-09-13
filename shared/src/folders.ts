/**
 * Where a workflow lives.
 *
 * Workflows sit in folders the way files do, and a folder is named by its
 * path: segments joined by `/`, no leading or trailing slash — `Examples`,
 * `Clients/Acme`. The root is the empty string. It is not stored anywhere
 * and cannot be renamed or deleted; every other folder is a row, so an
 * empty one exists until it is removed, the way an empty directory does.
 *
 * A path is the folder's identity. Renaming a folder rewrites the paths
 * under it, which is one statement in SQLite; the trade is that nothing
 * points at a folder by an id that survives a rename. Nothing needed to.
 *
 * Both sides use these: the server to check what it is asked to make, the
 * client to say where it is.
 */

/** The root: every workflow's default home, and where new ones are saved. */
export const ROOT_FOLDER = '';

/** The folder the shipped examples live in. */
export const EXAMPLES_FOLDER = 'Examples';

export const FOLDER_SEPARATOR = '/';

/** How long a segment may be. Long enough for a sentence, short enough to list. */
export const MAX_FOLDER_NAME_LENGTH = 80;

/** A folder as stored. */
export interface Folder {
  path: string;
  createdAt: number;
}

/** A folder as the listing shows it: with what it holds, all the way down. */
export interface FolderEntry extends Folder {
  name: string;
  /** Workflows in it and in every folder under it. */
  workflowCount: number;
  /** Folders under it, all the way down. */
  folderCount: number;
}

/** A workflow as the listing shows it — enough to pick one, none of its graph. */
export interface WorkflowSummary {
  id: string;
  name: string;
  folder: string;
  nodeCount: number;
  /** Runs recorded against it. They go with it when it is deleted. */
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

/** One level of the tree: what is in a folder. */
export interface FolderListing {
  path: string;
  folders: FolderEntry[];
  workflows: WorkflowSummary[];
}

/** The segments of a path; none for the root. */
export function folderSegments(path: string): string[] {
  return path === ROOT_FOLDER ? [] : path.split(FOLDER_SEPARATOR);
}

/** The last segment — what the folder is called. Empty for the root. */
export function folderName(path: string): string {
  const segments = folderSegments(path);
  return segments.length ? segments[segments.length - 1] : ROOT_FOLDER;
}

/** The folder above. The root is its own parent, which is where a walk up stops. */
export function parentFolder(path: string): string {
  const segments = folderSegments(path);
  return segments.slice(0, -1).join(FOLDER_SEPARATOR);
}

/** The path of `name` inside `parent`. */
export function childFolder(parent: string, name: string): string {
  return parent === ROOT_FOLDER ? name : `${parent}${FOLDER_SEPARATOR}${name}`;
}

/** True when `path` is `ancestor` or lies under it. Everything is within the root. */
export function isWithinFolder(path: string, ancestor: string): boolean {
  if (ancestor === ROOT_FOLDER) return true;
  return path === ancestor || path.startsWith(ancestor + FOLDER_SEPARATOR);
}

/**
 * Why `name` cannot be a folder name, or null when it can.
 *
 * A name is one segment: no slash either way (a slash is the separator, and
 * a backslash reads as one on Windows), not blank, not the two names every
 * filesystem reserves for "here" and "up".
 */
export function folderNameError(name: string): string | null {
  if (name.trim() === '') return 'A folder needs a name';
  if (name !== name.trim()) return 'A folder name cannot start or end with a space';
  if (name === '.' || name === '..') return `"${name}" is not a name a folder can have`;
  if (name.includes('/') || name.includes('\\')) return 'A folder name cannot contain a slash';
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return `A folder name can be at most ${MAX_FOLDER_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * A path as the user typed it, made canonical: segments trimmed, empty ones
 * dropped (so `/Clients//Acme/` is `Clients/Acme`), each one checked.
 * Anything that is not a string, or has a segment that cannot be a name,
 * comes back as an error saying which.
 */
export function normalizeFolderPath(input: unknown): { path: string } | { error: string } {
  if (input === undefined || input === null) return { path: ROOT_FOLDER };
  if (typeof input !== 'string') return { error: 'A folder path must be a string' };

  const segments = input
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

  for (const segment of segments) {
    const problem = folderNameError(segment);
    if (problem) return { error: `${problem} (in "${input}")` };
  }
  return { path: segments.join(FOLDER_SEPARATOR) };
}

/** Every folder on the way to `path`, nearest the root first, not counting the root. */
export function ancestorFolders(path: string): string[] {
  const segments = folderSegments(path);
  return segments.map((_, i) => segments.slice(0, i + 1).join(FOLDER_SEPARATOR));
}

/** `Workflows › Examples › Drafts` as a list of { path, name }, the root first. */
export function breadcrumbs(path: string, rootLabel = 'Workflows'): Array<{ path: string; name: string }> {
  return [
    { path: ROOT_FOLDER, name: rootLabel },
    ...ancestorFolders(path).map((ancestor) => ({ path: ancestor, name: folderName(ancestor) }))
  ];
}
