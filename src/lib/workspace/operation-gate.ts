import 'server-only';

type WorkspaceOperationState = {
  active: number;
  closing: boolean;
  drained?: Promise<void>;
  resolveDrained?: () => void;
};

const gateGlobal = globalThis as typeof globalThis & {
  __workspaceOperationStates?: Map<string, WorkspaceOperationState>;
};

function states(): Map<string, WorkspaceOperationState> {
  return gateGlobal.__workspaceOperationStates ??= new Map();
}

export function beginWorkspaceOperation(workspaceId: string): (() => void) | null {
  const entries = states();
  let state = entries.get(workspaceId);
  if (state?.closing) return null;
  if (!state) {
    state = { active: 0, closing: false };
    entries.set(workspaceId, state);
  }
  state.active += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state!.active -= 1;
    if (state!.active !== 0) return;
    state!.resolveDrained?.();
    if (!state!.closing && entries.get(workspaceId) === state) {
      entries.delete(workspaceId);
    }
  };
}

export async function closeWorkspaceOperations(workspaceId: string): Promise<void> {
  const entries = states();
  let state = entries.get(workspaceId);
  if (!state) {
    state = { active: 0, closing: true };
    entries.set(workspaceId, state);
  } else {
    state.closing = true;
  }
  if (state.active === 0) return;
  if (!state.drained) {
    state.drained = new Promise<void>((resolve) => {
      state!.resolveDrained = resolve;
    });
  }
  await state.drained;
}
