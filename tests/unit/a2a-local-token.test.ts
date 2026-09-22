// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createAgentRuntimeToken, verifyAgentRuntimeToken } from '@/lib/agents/runtime-access';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';

describe('native A2A execution credentials and sandbox serialization', () => {
  it('signs both task ID and lease, and rejects incomplete task authority', async () => {
    process.env.AUTH_SECRET = 'test-only-native-task-token-secret';
    const payload = { workspaceId: 'ws', agentId: 'agent', sandboxId: 'sandbox', providerId: 'provider',
      deploymentIds: [], exp: Math.floor(Date.now() / 1000) + 60 };
    const token = await createAgentRuntimeToken({ ...payload, a2aTaskId: 'task', a2aLeaseToken: 'lease' });
    expect(await verifyAgentRuntimeToken(token)).toMatchObject({ a2aTaskId: 'task', a2aLeaseToken: 'lease' });
    await expect(createAgentRuntimeToken({ ...payload, a2aTaskId: 'task' })).rejects.toThrow();
    await expect(createAgentRuntimeToken({ ...payload, a2aLeaseToken: 'lease' })).rejects.toThrow();
    expect(await verifyAgentRuntimeToken(token.slice(0, -3) + 'bad')).toBeNull();
  });
  it('reserves one sandbox, permits nested runtime dispatch and always releases the lease', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = withSandboxExecutionLease('sandbox', async () => {
      await withSandboxExecutionLease('sandbox', async () => undefined);
      await blocked;
    });
    expect(() => withSandboxExecutionLease('sandbox', async () => undefined)).toThrow();
    await withSandboxExecutionLease('other-sandbox', async () => undefined);
    release(); await first;
    await expect(withSandboxExecutionLease('sandbox', async () => { throw new Error('fixture'); })).rejects.toThrow();
    await withSandboxExecutionLease('sandbox', async () => undefined);
  });
});
