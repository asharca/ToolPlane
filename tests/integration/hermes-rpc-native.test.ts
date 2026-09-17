// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
// No live provider keys: the pinned upstream executes against local HTTP/MCP fixtures.
const enabled = Boolean(process.env.HERMES_RPC_SOURCE && process.env.HERMES_RPC_PYTHONPATH);
describe.skipIf(!enabled)('pinned Hermes RPC native contract', () => {
  it('runs, restarts, resumes, rotates grants and executes selected Skills/MCP', () => {
    const result = spawnSync(process.env.HERMES_RPC_TEST_PYTHON || 'python3', ['tests/fixtures/hermes-rpc-native-check.py'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1_000_000 });
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('real MCP round-trip passed');
  }, 130_000);
});
