import type { Folder, FolderListing, Workflow } from '@joseki/shared';

/**
 * The workflow library over HTTP: folders, and the things done to a
 * workflow that are not editing it. The canvas keeps its own save path in
 * the store; this is what the Open dialog calls.
 *
 * Every failure is thrown as an Error whose message is the server's, so a
 * dialog can show it as it is.
 */

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await describeFailure(response));
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const details = Array.isArray(body.details) ? `: ${body.details.join('; ')}` : '';
    return `${body.error || `The server answered ${response.status}`}${details}`;
  } catch {
    return `The server answered ${response.status}`;
  }
}

const q = encodeURIComponent;

export const listFolder = (path: string) => request<FolderListing>('GET', `/api/folders?path=${q(path)}`);

export const allFolders = () => request<Folder[]>('GET', '/api/folders/all');

export const createFolder = (path: string) =>
  request<Folder & { created: boolean }>('POST', '/api/folders', { path });

export const renameFolder = (path: string, newPath: string) =>
  request<Folder>('PATCH', '/api/folders', { path, newPath });

export const deleteFolder = (path: string, recursive: boolean) =>
  request<{ deleted: { workflows: number; folders: number } }>(
    'DELETE',
    `/api/folders?path=${q(path)}${recursive ? '&recursive=true' : ''}`
  );

export const getWorkflow = (id: string) => request<Workflow>('GET', `/api/workflows/${q(id)}`);

export const renameWorkflow = (id: string, name: string) =>
  request<Workflow>('PATCH', `/api/workflows/${q(id)}`, { name });

export const moveWorkflow = (id: string, folder: string) =>
  request<Workflow>('PATCH', `/api/workflows/${q(id)}`, { folder });

export const deleteWorkflow = (id: string) => request<void>('DELETE', `/api/workflows/${q(id)}`);

export const restoreExamples = () =>
  request<{ restored: Workflow[] }>('POST', '/api/workflows/examples/restore');

/** Whether a failed request was a 404 — the one status a caller acts on rather than shows. */
export async function exists(id: string): Promise<Workflow | undefined> {
  const response = await fetch(`/api/workflows/${q(id)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await describeFailure(response));
  return (await response.json()) as Workflow;
}
