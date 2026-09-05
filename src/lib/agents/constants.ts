// A response normally stops when the model emits no tool calls. This cap is a
// runaway backstop for responses that keep requesting another tool round.
export const AGENT_STEP_BOUNDS = { min: 1, max: 1000, default: 100 } as const;

export const REASONING_EFFORTS = [
  'default',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? value as ReasoningEffort
    : null;
}

export function resolveMaxSteps(maxSteps: number): number {
  const steps = Math.trunc(maxSteps);
  if (!Number.isFinite(steps) || steps < AGENT_STEP_BOUNDS.min) return AGENT_STEP_BOUNDS.default;
  return Math.min(AGENT_STEP_BOUNDS.max, steps);
}

// How deep an agent → sub-agent → sub-sub-agent delegation chain may nest. A
// runtime guard refuses calls past this depth (alongside a cycle guard) so a
// misconfigured graph can't loop or run away in cost.
export const AGENT_MAX_DEPTH = 3;
