// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getSandbox, listSandboxes } from '@/lib/sandboxes/queries';

const stamp = `${process.pid}-${Date.now()}`;
let userId = '';
let workspaceId = '';
let otherWorkspaceId = '';
let deploymentId = '';
let sandboxId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `sandbox-snapshots-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const [workspace, otherWorkspace] = await Promise.all([
    db.workspace.create({
      data: {
        slug: `sandbox-snapshots-${stamp}`,
        name: 'Snapshots',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    }),
    db.workspace.create({
      data: {
        slug: `sandbox-snapshots-other-${stamp}`,
        name: 'Other snapshots',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    }),
  ]);
  workspaceId = workspace.id;
  otherWorkspaceId = otherWorkspace.id;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: 'Sandbox', source: 'sandbox', status: 'stopped' },
  });
  deploymentId = deployment.id;
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId,
      name: 'Snapshot lab',
      slug: 'snapshot-lab',
      kind: 'docker',
      image: 'alpine:3.20',
    },
  });
  sandboxId = sandbox.id;
  await db.sandboxSnapshot.createMany({
    data: [
      {
        sandboxId,
        name: 'Older',
        volumeName: `snapshot_older_${stamp}`,
        status: 'ready',
        createdAt: new Date('2026-07-13T00:00:00.000Z'),
      },
      {
        sandboxId,
        name: 'Newer',
        volumeName: `snapshot_newer_${stamp}`,
        status: 'ready',
        createdAt: new Date('2026-07-14T00:00:00.000Z'),
      },
    ],
  });
});

afterAll(async () => {
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

describe('sandbox snapshot persistence', () => {
  it('returns snapshots newest first only through the owning workspace', async () => {
    const sandbox = await getSandbox(workspaceId, sandboxId);

    expect(sandbox?.snapshots.map((snapshot) => snapshot.name)).toEqual(['Newer', 'Older']);
    await expect(getSandbox(otherWorkspaceId, sandboxId)).resolves.toBeNull();
  });

  it('includes snapshot counts in the sandbox inventory', async () => {
    const sandboxes = await listSandboxes(workspaceId);

    expect(sandboxes.find((sandbox) => sandbox.id === sandboxId)?._count.snapshots).toBe(2);
  });

  it('cascades snapshot rows when the backing deployment is deleted', async () => {
    await db.deployment.delete({ where: { id: deploymentId } });

    await expect(db.sandboxSnapshot.count({ where: { sandboxId } })).resolves.toBe(0);
    await expect(db.sandbox.findUnique({ where: { id: sandboxId } })).resolves.toBeNull();
  });
});
