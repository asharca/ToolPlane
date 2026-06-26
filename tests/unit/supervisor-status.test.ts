// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { effectiveStatus } from '@/lib/process/supervisor';

// With no live process in the (empty) supervisor table, an active DB status is
// stale and must downgrade to 'stopped'; terminal states pass through.
describe('effectiveStatus (no live process)', () => {
  it('downgrades stale active states to stopped', () => {
    expect(effectiveStatus('unknown-running', 'running')).toBe('stopped');
    expect(effectiveStatus('unknown-provisioning', 'provisioning')).toBe('stopped');
  });

  it('passes terminal states through unchanged', () => {
    expect(effectiveStatus('unknown-stopped', 'stopped')).toBe('stopped');
    expect(effectiveStatus('unknown-error', 'error')).toBe('error');
  });
});
