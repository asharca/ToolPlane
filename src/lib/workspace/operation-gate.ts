import "server-only";
import {
  assertRuntimeOwner,
  beginRuntimeOperation,
} from "@/lib/runtime/ownership-state";

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
  gateGlobal.__workspaceOperationStates ??= new Map();
  return gateGlobal.__workspaceOperationStates;
}

export function beginWorkspaceOperation(
  workspaceId: string,
): (() => void) | null {
  assertRuntimeOwner();
  const entries = states();
  let state = entries.get(workspaceId);
  if (state?.closing) return null;
  if (!state) {
    state = { active: 0, closing: false };
    entries.set(workspaceId, state);
  }
  const releaseRuntime = beginRuntimeOperation();
  state.active += 1;
  const operationState = state;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseRuntime();
    operationState.active -= 1;
    if (operationState.active !== 0) return;
    operationState.resolveDrained?.();
    if (
      !operationState.closing &&
      entries.get(workspaceId) === operationState
    ) {
      entries.delete(workspaceId);
    }
  };
}

export async function closeWorkspaceOperations(
  workspaceId: string,
): Promise<void> {
  const entries = states();
  let state = entries.get(workspaceId);
  if (!state) {
    state = { active: 0, closing: true };
    entries.set(workspaceId, state);
  } else {
    state.closing = true;
  }
  if (state.active === 0) return;
  const closingState = state;
  if (!state.drained) {
    state.drained = new Promise<void>((resolve) => {
      closingState.resolveDrained = resolve;
    });
  }
  await state.drained;
}
