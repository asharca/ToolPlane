// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  effectiveStatus,
  effectiveStatuses,
  livePort,
  liveStatus,
} from '@/lib/process/supervisor';

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

  it('reads live state from the cross-worker process registry', () => {
    const deploymentId = `registry-test-${Date.now()}`;
    const dir = path.join(os.tmpdir(), 'toolplane-supervisor');
    const file = path.join(dir, `${deploymentId}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        deploymentId,
        name: 'test',
        pid: process.pid,
        port: 45678,
        status: 'running',
        updatedAt: new Date().toISOString(),
      }),
    );

    try {
      expect(liveStatus(deploymentId)).toBe('running');
      expect(livePort(deploymentId)).toBe(45678);
      expect(effectiveStatus(deploymentId, 'stopped')).toBe('running');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('resolves a batch from one registry snapshot and downgrades stale active states', () => {
    const deploymentId = `registry-batch-test-${Date.now()}`;
    const dir = path.join(os.tmpdir(), 'toolplane-supervisor');
    const file = path.join(dir, `${deploymentId}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        deploymentId,
        name: 'batch test',
        pid: process.pid,
        port: 45679,
        status: 'running',
        updatedAt: new Date().toISOString(),
      }),
    );

    try {
      const statuses = effectiveStatuses([
        { id: deploymentId, status: 'stopped' },
        { id: 'missing-active', status: 'running' },
        { id: 'missing-error', status: 'error' },
      ]);
      expect(statuses.get(deploymentId)).toBe('running');
      expect(statuses.get('missing-active')).toBe('stopped');
      expect(statuses.get('missing-error')).toBe('error');
    } finally {
      rmSync(file, { force: true });
    }
  });
});
