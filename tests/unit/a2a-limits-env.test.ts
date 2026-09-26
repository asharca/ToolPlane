// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

// Static import cannot work here: A2A_LIMITS is resolved once at module load,
// so each case must re-import the module under fresh env via vi.resetModules().
describe('TOOLPLANE_A2A_* environment overrides', () => {
  const envKeys = ['TOOLPLANE_A2A_BODY_BYTES', 'TOOLPLANE_A2A_INPUT_CHARACTERS', 'TOOLPLANE_A2A_OUTPUT_CHARACTERS', 'TOOLPLANE_A2A_SNAPSHOT_BYTES', 'TOOLPLANE_A2A_PUBLISH_ARTIFACT_BYTES'];
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('keeps built-in defaults without env', async () => {
    vi.resetModules();
    const { A2A_LIMITS } = await import('@/lib/a2a/model');
    expect(A2A_LIMITS.outputCharacters).toBe(65_536);
    expect(A2A_LIMITS.bodyBytes).toBe(262_144);
    expect(A2A_LIMITS.messagesPerTask).toBe(32);
  });

  it('overrides the five size/character limits and leaves counters fixed', async () => {
    vi.resetModules();
    vi.stubEnv('TOOLPLANE_A2A_OUTPUT_CHARACTERS', '250000');
    vi.stubEnv('TOOLPLANE_A2A_BODY_BYTES', '4096');
    const { A2A_LIMITS } = await import('@/lib/a2a/model');
    expect(A2A_LIMITS.outputCharacters).toBe(250_000);
    expect(A2A_LIMITS.bodyBytes).toBe(4_096);
    expect(A2A_LIMITS.messagesPerTask).toBe(32);
  });

  it('rejects invalid values with the offending key named', async () => {
    vi.resetModules();
    vi.stubEnv('TOOLPLANE_A2A_OUTPUT_CHARACTERS', '-5');
    await expect(import('@/lib/a2a/model')).rejects.toThrow('TOOLPLANE_A2A_OUTPUT_CHARACTERS');
    expect(envKeys).toHaveLength(5);
  });
});
