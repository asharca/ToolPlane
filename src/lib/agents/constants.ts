// Shared bounds for an agent's tool-step cap, used by both the settings form
// (input min/max) and the update action (server-side clamp) so the limit lives
// in one place.
export const AGENT_STEP_BOUNDS = { min: 1, max: 20, default: 8 } as const;

// How deep an agent → sub-agent → sub-sub-agent delegation chain may nest. A
// runtime guard refuses calls past this depth (alongside a cycle guard) so a
// misconfigured graph can't loop or run away in cost.
export const AGENT_MAX_DEPTH = 3;
