// JSON Merge Patch (RFC 7386) — the semantics of a PATCH whose fields can be
// nested objects. Used for conversation `params`, where `routing`, `sampling`
// and `reasoning` are objects that would otherwise be replaced whole.

/**
 * Apply a JSON Merge Patch: objects merge key by key, recursively; `null`
 * removes the key it sits under; arrays and scalars replace whatever was there.
 * `undefined` in a patch means "no change" (JSON cannot carry it, but callers
 * building partial objects in TypeScript can). Neither argument is mutated,
 * and a non-object patch replaces the target outright — as the RFC specifies.
 */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch)) return patch as T;
  const merged: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
