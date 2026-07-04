import { describe, it, expect } from 'vitest';
import { resolveMaxSteps, AGENT_STEPS_CEILING, AGENT_STEP_BOUNDS } from '@/lib/agents/constants';

describe('resolveMaxSteps', () => {
  it('maps 0 (no limit) to the safety ceiling', () => {
    expect(resolveMaxSteps(0)).toBe(AGENT_STEPS_CEILING);
  });

  it('passes a positive cap through unchanged', () => {
    expect(resolveMaxSteps(18)).toBe(18);
    expect(resolveMaxSteps(AGENT_STEP_BOUNDS.default)).toBe(AGENT_STEP_BOUNDS.default);
  });

  it('treats any non-positive value as no limit', () => {
    expect(resolveMaxSteps(-5)).toBe(AGENT_STEPS_CEILING);
  });
});
