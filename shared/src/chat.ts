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
