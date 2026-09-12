// Chat helpers shared by the server and the client.

/**
 * The branch in view: the messages from the root down to `activeLeafId`,
 * oldest first. Siblings off that path are other branches and are left out.
 * Empty when there is no active leaf or it is not among the messages.
 */
export function activePath<T extends { id: string; parentId: string | null }>(
  messages: T[],
  activeLeafId: string | null | undefined
): T[] {
  if (!activeLeafId) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: T[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(activeLeafId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.reverse();
}

interface TreeMessage {
  id: string;
  parentId: string | null;
  createdAt: number;
}

function byCreation<T extends TreeMessage>(a: T, b: T): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The alternatives at one point of the tree: every message sharing
 * `message`'s parent — the message itself included — oldest first. A retry
 * or an edit makes a sibling; the branch counter counts these.
 */
export function siblingsOf<T extends TreeMessage>(messages: T[], message: T): T[] {
  return messages.filter((candidate) => candidate.parentId === message.parentId).sort(byCreation);
}

/**
 * The leaf a branch shows when it is chosen: from `id`, follow the newest
 * child down until a message with no children. Cycles cannot occur in a
 * stored tree, but a guard keeps a malformed one from looping.
 */
export function latestLeafUnder<T extends TreeMessage>(messages: T[], id: string): string {
  const seen = new Set<string>();
  let cursor = id;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const children = messages.filter((candidate) => candidate.parentId === cursor && !seen.has(candidate.id));
    if (children.length === 0) break;
    children.sort(byCreation);
    cursor = children[children.length - 1].id;
  }
  return cursor;
}
