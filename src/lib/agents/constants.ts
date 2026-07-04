// Shared bounds for an agent's tool-step cap, used by both the settings form
// (input min/max) and the update action (server-side clamp) so the limit lives
// in one place. The AI SDK loop already stops on its own when the model emits a
// step with no tool calls, so this cap is only a runaway backstop, not a budget
// a normal task spends down. `0` means "no limit": it resolves at run time (see
// resolveMaxSteps) to AGENT_STEPS_CEILING so a stuck agent still can't loop
// without end, while no real task ever reaches it.
export const AGENT_STEP_BOUNDS = { min: 0, max: 1000, default: 8 } as const;

// Concrete ceiling that "no limit" (stored 0) maps to at run time.
export const AGENT_STEPS_CEILING = 1000;

// Resolve a stored maxSteps to the step count the SDK loop should stop at.
// 0 (unlimited) → the safety ceiling; any positive value is used as-is.
export function resolveMaxSteps(maxSteps: number): number {
  return maxSteps > 0 ? maxSteps : AGENT_STEPS_CEILING;
}

// How deep an agent → sub-agent → sub-sub-agent delegation chain may nest. A
// runtime guard refuses calls past this depth (alongside a cycle guard) so a
// misconfigured graph can't loop or run away in cost.
export const AGENT_MAX_DEPTH = 3;
