/** Safe ids for bots, skills, routines — no path traversal, no weird chars. */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertSafeId(kind: string, id: string): string {
  const trimmed = id.trim();
  if (!ID_RE.test(trimmed)) {
    throw new Error(
      `${kind} id must match ${ID_RE} (got ${JSON.stringify(id)})`,
    );
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(`${kind} id must not contain path separators`);
  }
  return trimmed;
}

export function isSafeId(id: string): boolean {
  try {
    assertSafeId("id", id);
    return true;
  } catch {
    return false;
  }
}
