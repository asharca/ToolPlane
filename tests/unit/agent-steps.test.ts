import { describe, it, expect } from 'vitest';
import { resolveMaxSteps, AGENT_STEP_BOUNDS } from '@/lib/agents/constants';

describe('resolveMaxSteps', () => {
  it('uses the Cherry-style bounded default', () => {
    expect(AGENT_STEP_BOUNDS).toEqual({ min: 1, max: 1000, default: 100 });
  });

  it('passes an in-range cap through unchanged', () => {
    expect(resolveMaxSteps(18)).toBe(18);
    expect(resolveMaxSteps(AGENT_STEP_BOUNDS.default)).toBe(AGENT_STEP_BOUNDS.default);
  });

  it('clamps runtime values to the supported range', () => {
    expect(resolveMaxSteps(0)).toBe(100);
    expect(resolveMaxSteps(-5)).toBe(100);
    expect(resolveMaxSteps(1001)).toBe(1000);
    expect(resolveMaxSteps(Number.NaN)).toBe(100);
  });
});
