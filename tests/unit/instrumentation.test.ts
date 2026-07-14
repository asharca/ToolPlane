import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureConnectorBroker: vi.fn(),
  ensureSandboxNetwork: vi.fn(),
  reconcileSandboxVolumeCopies: vi.fn(),
  reconcileDeployments: vi.fn(),
}));

vi.mock('@/lib/sandboxes/connector-broker', () => ({
  ensureConnectorBroker: mocks.ensureConnectorBroker,
}));
vi.mock('@/lib/process/supervisor', () => ({
  ensureSandboxNetwork: mocks.ensureSandboxNetwork,
}));
vi.mock('@/lib/sandboxes/reconcile', () => ({
  reconcileSandboxVolumeCopies: mocks.reconcileSandboxVolumeCopies,
}));
vi.mock('@/lib/process/reconcile', () => ({
  reconcileDeployments: mocks.reconcileDeployments,
}));

import { register } from '@/instrumentation';

const reconcileGlobal = globalThis as typeof globalThis & { __mcpReconciled?: boolean };

describe('startup sandbox lifecycle reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete reconcileGlobal.__mcpReconciled;
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.NEXT_PHASE;
    mocks.ensureConnectorBroker.mockResolvedValue(undefined);
    mocks.ensureSandboxNetwork.mockResolvedValue(undefined);
    mocks.reconcileDeployments.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete reconcileGlobal.__mcpReconciled;
    delete process.env.NEXT_RUNTIME;
    delete process.env.NEXT_PHASE;
  });

  it('continues normal deployment recovery and retries when Docker helper cleanup fails', async () => {
    mocks.reconcileSandboxVolumeCopies
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce({
        helpersRemoved: 1,
        copiesInterrupted: 1,
        restoresInterrupted: 1,
        snapshotsInterrupted: 1,
      });

    await register();

    expect(mocks.reconcileDeployments).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileSandboxVolumeCopies).toHaveBeenCalledTimes(1);
    const firstCutoff = mocks.reconcileSandboxVolumeCopies.mock.calls[0][0].helpersCreatedBefore;
    expect(firstCutoff).toBeInstanceOf(Date);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.reconcileSandboxVolumeCopies).toHaveBeenCalledTimes(2);
    expect(
      mocks.reconcileSandboxVolumeCopies.mock.calls[1][0].helpersCreatedBefore,
    ).toBe(firstCutoff);
  });
});
