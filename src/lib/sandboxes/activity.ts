import "server-only";
const root = globalThis as typeof globalThis & {
  __sandboxAccess?: Map<string, { active: number; usedAt: number }>;
  __sandboxFrozen?: Set<string>;
};
root.__sandboxAccess ??= new Map();
root.__sandboxFrozen ??= new Set();
export const sandboxAccesses = root.__sandboxAccess;
export const frozenSandboxes = root.__sandboxFrozen;
export function beginAgentConversationSandboxAccess(
  sandboxId: string,
): () => void {
  if (frozenSandboxes.has(sandboxId))
    throw new Error("Sandbox lifecycle operation is in progress.");
  const entry = sandboxAccesses.get(sandboxId) ?? {
    active: 0,
    usedAt: Date.now(),
  };
  entry.active += 1;
  entry.usedAt = Date.now();
  sandboxAccesses.set(sandboxId, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.active -= 1;
    entry.usedAt = Date.now();
  };
}
