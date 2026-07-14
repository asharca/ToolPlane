'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  allowProcessRestart,
  effectiveStatus,
  startProcess,
  stopProcess,
  restartProcess,
  killProcess,
} from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import {
  copyDockerVolume,
  DockerVolumeCopyCleanupError,
  removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict,
  removeDockerVolumeCopyHelper,
  removeDockerVolumeStrict,
  sandboxSnapshotVolumeName,
  sandboxVolumeName,
  stopDockerSandboxContainer,
} from './runtime';
import { parseSandboxEnvText, readSandboxEnv, sandboxConfigWithEnv } from './env';
import { resolveSandboxImage } from './images';
import {
  connectorFromConfig,
  connectorServerUrlFromHeaders,
  connectorSourceRef,
  createConnectorConfig,
  type SandboxConnectorConfig,
} from './connector';
import { disconnectConnector } from './connector-broker';
import { setConnectorSetupTokenCookie } from './connector-setup-token';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'sandbox';
}

function cleanName(input: FormDataEntryValue | null): string {
  return String(input ?? '').trim().slice(0, 80);
}

async function uniqueSlug(workspaceId: string, name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let i = 1; await db.sandbox.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${base}-${i}`;
  }
  return slug;
}

async function sandboxInWorkspace(sandboxId: string, workspaceId: string) {
  return db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId },
    include: { deployment: true, snapshots: true },
  });
}

type AuthorizedSandbox = NonNullable<Awaited<ReturnType<typeof sandboxInWorkspace>>>;

type QuiescedOperationControl = {
  preventResume: () => void;
};

const sandboxOperationGlobal = globalThis as typeof globalThis & {
  __sandboxOperationQueues?: Map<string, Promise<void>>;
};

function scheduleRestoreHelperCleanup(
  error: DockerVolumeCopyCleanupError,
  deploymentId: string,
  workspaceId: string,
  attempt = 1,
): void {
  if (!error.helperName) return;
  const retry = setTimeout(async () => {
    try {
      await removeDockerVolumeCopyHelper(error.helperName!);
      await db.deployment.updateMany({
        where: {
          id: deploymentId,
          workspaceId,
          source: 'sandbox',
          status: { in: ['restoring', 'restore_cleanup_required'] },
        },
        data: { status: 'restore_failed' },
      });
    } catch {
      if (attempt < 6) {
        scheduleRestoreHelperCleanup(error, deploymentId, workspaceId, attempt + 1);
      }
    }
  }, Math.min(30_000, 1_000 * (2 ** (attempt - 1))));
  retry.unref?.();
}

function enqueueSandboxOperation<T>(
  workspaceId: string,
  sandboxId: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const releaseWorkspaceOperation = beginWorkspaceOperation(workspaceId);
  if (!releaseWorkspaceOperation) return Promise.resolve(undefined);
  const queues = sandboxOperationGlobal.__sandboxOperationQueues ??= new Map();
  const previous = queues.get(sandboxId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(sandboxId, tail);
  return result.finally(() => {
    if (queues.get(sandboxId) === tail) queues.delete(sandboxId);
    releaseWorkspaceOperation();
  });
}

function sandboxDataVolume(sandbox: AuthorizedSandbox): string {
  const cfg = (sandbox.deployment.installCfg ?? {}) as { volumeName?: string };
  return cfg.volumeName || sandboxVolumeName(sandbox.id);
}

const DATA_OPERATION_BLOCKED_STATES = new Set([
  'provisioning',
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
  'deleting',
]);
const RESTORE_BLOCKED_STATES = new Set([
  'provisioning',
  'copying',
  'copy_failed',
  'restoring',
  'restore_cleanup_required',
  'deleting',
]);

function sandboxDataOperationBlocked(sandbox: AuthorizedSandbox): boolean {
  return DATA_OPERATION_BLOCKED_STATES.has(
    effectiveStatus(sandbox.deploymentId, sandbox.deployment.status),
  );
}

function sandboxLifecycleBlocked(sandbox: AuthorizedSandbox): boolean {
  return [
    'copying',
    'copy_failed',
    'restoring',
    'restore_failed',
    'restore_cleanup_required',
    'deleting',
  ]
    .includes(sandbox.deployment.status);
}

async function quiesceDockerSandbox<T>(
  sandbox: AuthorizedSandbox,
  operation: (control: QuiescedOperationControl) => Promise<T>,
  options: { quiescedStatus?: string } = {},
): Promise<T> {
  const status = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
  if (RESTORE_BLOCKED_STATES.has(status)) {
    throw new Error('Wait for the sandbox data operation to finish.');
  }
  const shouldResume = status === 'running';
  let resumeAllowed = true;

  if (options.quiescedStatus) {
    await killProcess(sandbox.deploymentId, { finalStatus: options.quiescedStatus });
  } else {
    await killProcess(sandbox.deploymentId);
  }
  try {
    await stopDockerSandboxContainer(sandbox.id);
    return await operation({ preventResume: () => { resumeAllowed = false; } });
  } finally {
    if (shouldResume && resumeAllowed) {
      await startProcess(sandbox.deploymentId, resolveSpawnSpec(sandbox.deployment), {
        awaitReady: false,
        workspaceId: sandbox.workspaceId,
      });
    }
  }
}

function installCfgForSandbox(sandbox: {
  id: string;
  kind: string;
  image: string | null;
  network: string;
  config: Prisma.JsonValue | null;
}): Prisma.InputJsonValue {
  const connector = connectorFromConfig(sandbox.config);
  const env = readSandboxEnv(sandbox.config);
  return {
    sandboxId: sandbox.id,
    kind: sandbox.kind,
    image: sandbox.image,
    network: sandbox.network,
    volumeName: sandboxVolumeName(sandbox.id),
    connector: connector ?? undefined,
    env,
  };
}

async function createCloneRecord({
  source,
  workspaceId,
  deploymentId,
  sandboxId,
  name,
  slug,
}: {
  source: AuthorizedSandbox;
  workspaceId: string;
  deploymentId: string;
  sandboxId: string;
  name: string;
  slug: string;
}) {
  return db.$transaction(async (tx) => {
    const deployment = await tx.deployment.create({
      data: {
        id: deploymentId,
        workspaceId,
        serverId: null,
        name: `Sandbox: ${name}`,
        source: 'sandbox',
        sourceRef: source.image,
        status: 'copying',
      },
    });
    const sandbox = await tx.sandbox.create({
      data: {
        id: sandboxId,
        workspaceId,
        deploymentId: deployment.id,
        name,
        slug,
        kind: 'docker',
        image: source.image,
        network: source.network,
        ...(source.config === null ? {} : { config: source.config as Prisma.InputJsonValue }),
      },
    });
    const updatedDeployment = await tx.deployment.update({
      where: { id: deployment.id },
      data: { installCfg: installCfgForSandbox(sandbox) },
    });
    return { sandbox, deployment: updatedDeployment };
  });
}

export async function createSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const releaseWorkspaceOperation = beginWorkspaceOperation(ctx.ws.id);
  if (!releaseWorkspaceOperation) return;

  try {
    const kind = String(formData.get('kind') ?? 'docker') === 'connector' ? 'connector' : 'docker';
    const name = String(formData.get('name') ?? '').trim()
      || (kind === 'connector' ? 'Connected computer' : 'Linux sandbox');
    const sandboxSlug = await uniqueSlug(ctx.ws.id, name);
    const network = String(formData.get('network') ?? 'isolated') === 'none' ? 'none' : 'isolated';
    const env = parseSandboxEnvText(formData.get('env'));
    const image = kind === 'docker'
      ? resolveSandboxImage(
          formData.get('imageChoice'),
          formData.get('customImage') ?? formData.get('image'),
        )
      : null;
    const connectorBundle = kind === 'connector'
      ? createConnectorConfig({ serverUrl: connectorServerUrlFromHeaders(await headers()) })
      : undefined;
    const connectorConfig: SandboxConnectorConfig | undefined = connectorBundle?.config;

    const dep = await db.deployment.create({
      data: {
        workspaceId: ctx.ws.id,
        serverId: null,
        name: `Sandbox: ${name}`,
        source: 'sandbox',
        sourceRef: kind === 'docker'
          ? image
          : connectorConfig ? connectorSourceRef(connectorConfig) : 'connector://missing',
        status: 'provisioning',
      },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: ctx.ws.id,
        deploymentId: dep.id,
        name,
        slug: sandboxSlug,
        kind,
        image,
        network,
        config: sandboxConfigWithEnv(
          connectorConfig ? { connector: connectorConfig } : undefined,
          env,
        ),
      },
    });
    const installCfg = installCfgForSandbox(sandbox);
    const updated = await db.deployment.update({
      where: { id: dep.id },
      data: { installCfg },
    });

    await startProcess(updated.id, resolveSpawnSpec(updated), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
    revalidatePath(`/app/${slug}/sandboxes`);
    revalidatePath(`/app/${slug}/sandboxes/${sandbox.id}`);
    redirect(`/app/${slug}/sandboxes/${sandbox.id}`);
  } finally {
    releaseWorkspaceOperation();
  }
}

export async function cloneSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;

  const requestedName = cleanName(formData.get('name'));
  const defaultName = cleanName(formData.get('defaultName'));
  const targetSandboxId = randomUUID();
  const targetDeploymentId = randomUUID();
  const created = await enqueueSandboxOperation(ctx.ws.id, targetSandboxId, () => (
    enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
      const source = await sandboxInWorkspace(sandboxId, ctx.ws.id);
      if (!source || source.kind !== 'docker' || sandboxDataOperationBlocked(source)) return null;
      const name = requestedName || defaultName || `${source.name} copy`;
      const cloneSlug = await uniqueSlug(ctx.ws.id, name);
      let completedClone: Awaited<ReturnType<typeof createCloneRecord>> | null = null;

      try {
        return await quiesceDockerSandbox(source, async () => {
          const clone = await createCloneRecord({
            source,
            workspaceId: ctx.ws.id,
            deploymentId: targetDeploymentId,
            sandboxId: targetSandboxId,
            name,
            slug: cloneSlug,
          });
          try {
            await copyDockerVolume(sandboxDataVolume(source), sandboxVolumeName(clone.sandbox.id));
            const runnableDeployment = await db.deployment.update({
              where: { id: clone.deployment.id },
              data: { status: 'provisioning' },
            });
            const completed = { ...clone, deployment: runnableDeployment };
            await startProcess(completed.deployment.id, resolveSpawnSpec(completed.deployment), {
              awaitReady: false,
              workspaceId: ctx.ws.id,
            });
            completedClone = completed;
            return completed;
          } catch (error) {
            await killProcess(clone.deployment.id, {
              preventRestart: true,
              finalStatus: 'copy_failed',
            }).catch(() => undefined);
            try {
              await removeDockerSandboxRuntimeStrict(clone.sandbox.id, sandboxVolumeName(clone.sandbox.id));
              await db.deployment.deleteMany({
                where: { id: clone.deployment.id, workspaceId: ctx.ws.id, source: 'sandbox' },
              });
            } catch {
              await db.deployment.updateMany({
                where: { id: clone.deployment.id, workspaceId: ctx.ws.id },
                data: { status: 'copy_failed' },
              });
            }
            throw error;
          }
        });
      } catch (error) {
        if (completedClone) return completedClone;
        throw error;
      }
    })
  ));
  if (!created) return;

  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${created.sandbox.id}`);
  redirect(`/app/${slug}/sandboxes/${created.sandbox.id}`);
}

export async function createSandboxSnapshotAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;

  const name = cleanName(formData.get('name')) || cleanName(formData.get('defaultName')) || 'Snapshot';
  const snapshot = await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind !== 'docker' || sandboxDataOperationBlocked(sandbox)) return null;
    const snapshotId = randomUUID();
    const created = await db.sandboxSnapshot.create({
      data: {
        id: snapshotId,
        sandboxId: sandbox.id,
        name,
        volumeName: sandboxSnapshotVolumeName(snapshotId),
        status: 'creating',
      },
    });

    try {
      await quiesceDockerSandbox(sandbox, async () => {
        try {
          await copyDockerVolume(sandboxDataVolume(sandbox), created.volumeName);
        } catch (error) {
          throw error;
        }
      });
      await db.sandboxSnapshot.update({
        where: { id: created.id },
        data: { status: 'ready', error: null },
      });
      return created;
    } catch (error) {
      await db.sandboxSnapshot.updateMany({
        where: { id: created.id, sandboxId: sandbox.id },
        data: { status: 'error', error: 'Snapshot creation failed.' },
      });
      throw error;
    }
  });
  if (!snapshot) return;

  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function restoreSandboxSnapshotAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const snapshotId = String(formData.get('snapshotId') ?? '');
  const requestedRecoveryName = cleanName(formData.get('recoveryName'));
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId || !snapshotId) return;

  const restored = await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind !== 'docker') return false;
    const initialStatus = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
    if (RESTORE_BLOCKED_STATES.has(initialStatus)) return false;
    const restoringPreviousFailure = initialStatus === 'restore_failed';
    const snapshot = await db.sandboxSnapshot.findFirst({
      where: { id: snapshotId, sandboxId: sandbox.id, status: 'ready' },
    });
    if (!snapshot) return false;

    const ownedSandboxId = sandbox.id;
    const currentVolume = sandboxDataVolume(sandbox);
    const rollbackSnapshotId = `restore-${randomUUID()}`;
    const rollbackVolume = sandboxSnapshotVolumeName(rollbackSnapshotId);
    const rollbackName = requestedRecoveryName
      || `Restore recovery: ${snapshot.name || 'Snapshot'}`.slice(0, 80);
    let rollbackReady = false;
    let preserveRollback = false;
    let unsafeCopyCleanup: DockerVolumeCopyCleanupError | null = null;
    let operationError: unknown;

    await db.sandboxSnapshot.create({
      data: {
        id: rollbackSnapshotId,
        sandboxId: ownedSandboxId,
        name: rollbackName,
        volumeName: rollbackVolume,
        status: 'creating',
      },
    });

    async function markRollback(status: 'ready' | 'error' | 'deleting', error: string | null) {
      await db.sandboxSnapshot.updateMany({
        where: { id: rollbackSnapshotId, sandboxId: ownedSandboxId },
        data: {
          status,
          error,
        },
      });
    }

    try {
      await quiesceDockerSandbox(sandbox, async (control) => {
        try {
          await copyDockerVolume(currentVolume, rollbackVolume);
        } catch (error) {
          throw error;
        }
        rollbackReady = true;
        await markRollback('ready', null);
        await db.deployment.updateMany({
          where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
          data: { status: 'restoring' },
        });
        try {
          await copyDockerVolume(snapshot.volumeName, currentVolume, { replace: true });
        } catch (restoreError) {
          if (restoreError instanceof DockerVolumeCopyCleanupError) {
            preserveRollback = true;
            unsafeCopyCleanup = restoreError;
            control.preventResume();
            throw restoreError;
          }
          try {
            await copyDockerVolume(rollbackVolume, currentVolume, { replace: true });
          } catch (rollbackError) {
            preserveRollback = true;
            if (rollbackError instanceof DockerVolumeCopyCleanupError) {
              unsafeCopyCleanup = rollbackError;
            }
            control.preventResume();
            throw new AggregateError(
              [restoreError, rollbackError],
              'Snapshot restore and automatic rollback both failed.',
            );
          }
          try {
            await db.deployment.updateMany({
              where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
              data: { status: restoringPreviousFailure ? 'restore_failed' : 'stopped' },
            });
          } catch (statusError) {
            preserveRollback = true;
            control.preventResume();
            throw new AggregateError(
              [restoreError, statusError],
              'Snapshot rollback succeeded but its safe deployment state could not be persisted.',
            );
          }
          throw restoreError;
        }
        try {
          await db.deployment.updateMany({
            where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
            data: { status: 'stopped' },
          });
        } catch (statusError) {
          preserveRollback = true;
          control.preventResume();
          throw statusError;
        }
      }, restoringPreviousFailure ? { quiescedStatus: 'restore_failed' } : undefined);
      await db.sandboxSnapshot.update({
        where: { id: snapshot.id },
        data: { error: null },
      });
    } catch (error) {
      operationError = error;
    }

    if (preserveRollback) {
      try {
        await db.deployment.updateMany({
          where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
          data: { status: unsafeCopyCleanup ? 'restore_cleanup_required' : 'restore_failed' },
        });
      } catch (statusError) {
        operationError = new AggregateError(
          [operationError, statusError],
          'Snapshot restore failed and its recovery-required state could not be persisted.',
        );
      }
    }
    if (unsafeCopyCleanup) {
      scheduleRestoreHelperCleanup(
        unsafeCopyCleanup,
        sandbox.deploymentId,
        ctx.ws.id,
      );
    }

    let cleanupError: unknown;
    if (!(preserveRollback && rollbackReady)) {
      try {
        await markRollback('deleting', null);
        await removeDockerVolumeStrict(rollbackVolume);
        try {
          await db.sandboxSnapshot.deleteMany({
            where: { id: rollbackSnapshotId, sandboxId: ownedSandboxId },
          });
        } catch (deleteError) {
          cleanupError = deleteError;
          try {
            await markRollback('error', 'Restore backup cleanup failed.');
          } catch (persistError) {
            cleanupError = new AggregateError(
              [deleteError, persistError],
              'Restore backup record could not be removed or marked for retry.',
            );
          }
        }
      } catch (removeError) {
        cleanupError = removeError;
        try {
          await markRollback(
            rollbackReady ? 'ready' : 'error',
            rollbackReady ? null : 'Restore backup cleanup failed.',
          );
        } catch (persistError) {
          cleanupError = new AggregateError(
            [removeError, persistError],
            'Restore backup cleanup and recovery tracking both failed.',
          );
        }
      }
    }

    if (preserveRollback || cleanupError) {
      revalidatePath(`/app/${slug}/sandboxes`);
      revalidatePath(`/app/${slug}/sandboxes/${sandbox.id}`);
    }
    if (operationError) {
      if (cleanupError) {
        throw new AggregateError(
          [operationError, cleanupError],
          'Snapshot restore failed and its recovery backup could not be tracked.',
        );
      }
      throw operationError;
    }
    if (cleanupError) throw cleanupError;
    return true;
  });
  if (!restored) return;

  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function deleteSandboxSnapshotAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const snapshotId = String(formData.get('snapshotId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId || !snapshotId) return;

  await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind !== 'docker') return;
    const snapshot = await db.sandboxSnapshot.findFirst({
      where: { id: snapshotId, sandboxId: sandbox.id },
    });
    if (!snapshot) return;
    await db.sandboxSnapshot.update({
      where: { id: snapshot.id },
      data: { status: 'deleting', error: null },
    });
    try {
      await removeDockerVolumeStrict(snapshot.volumeName);
      await db.sandboxSnapshot.deleteMany({
        where: { id: snapshot.id, sandboxId: sandbox.id },
      });
    } catch (error) {
      await db.sandboxSnapshot.updateMany({
        where: { id: snapshot.id, sandboxId: sandbox.id },
        data: { status: 'error', error: 'Snapshot deletion failed.' },
      });
      throw error;
    }
  });
  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function updateSandboxEnvAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;

  await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox) return;
    if (sandbox.kind === 'hermes') return;
    if (sandboxLifecycleBlocked(sandbox)) return;

    const env = parseSandboxEnvText(formData.get('env'));
    const config = sandboxConfigWithEnv(sandbox.config, env);
    const installCfg = installCfgForSandbox({
      ...sandbox,
      config: (config ?? null) as Prisma.JsonValue | null,
    });
    const status = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
    const wasActive = status === 'running' || status === 'provisioning';

    const [, updatedDeployment] = await db.$transaction([
      db.sandbox.update({
        where: { id: sandbox.id },
        data: { config: config ?? {} },
      }),
      db.deployment.update({
        where: { id: sandbox.deploymentId },
        data: { installCfg },
      }),
    ]);

    if (sandbox.kind === 'docker') {
      await killProcess(sandbox.deploymentId);
      await removeDockerSandboxContainer(sandbox.id);
      if (wasActive) {
        await startProcess(sandbox.deploymentId, resolveSpawnSpec(updatedDeployment), {
          awaitReady: false,
          workspaceId: ctx.ws.id,
        });
      }
    } else if (sandbox.kind === 'connector' && connectorFromConfig(config) && wasActive) {
      await restartProcess(sandbox.deploymentId, resolveSpawnSpec(updatedDeployment), {
        awaitReady: false,
        workspaceId: ctx.ws.id,
      });
    }

    revalidatePath(`/app/${slug}/sandboxes`);
    revalidatePath(`/app/${slug}/sandboxes/${sandbox.id}`);
  });
}

export async function renameSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const name = cleanName(formData.get('name'));
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId || !name) return;

  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox) return;
  if (sandbox.kind === 'hermes') return;
  if (sandboxLifecycleBlocked(sandbox)) return;

  await db.$transaction([
    db.sandbox.update({
      where: { id: sandbox.id },
      data: { name },
    }),
    db.deployment.update({
      where: { id: sandbox.deploymentId },
      data: { name: `Sandbox: ${name}` },
    }),
  ]);
  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandbox.id}`);
}

export async function startSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind === 'hermes') return;
    if (sandboxLifecycleBlocked(sandbox)) return;
    if (sandbox.kind === 'host' || sandbox.kind === 'ssh') return;
    if (sandbox.kind === 'connector' && !connectorFromConfig(sandbox.config)) return;
    await startProcess(sandbox.deploymentId, resolveSpawnSpec(sandbox.deployment), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  });
  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function generateConnectorCommandAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;

  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox || sandbox.kind !== 'connector') return;
  if (sandboxLifecycleBlocked(sandbox)) return;
  const connector = connectorFromConfig(sandbox.config);
  if (!connector) return;

  const bundle = createConnectorConfig({
    serverUrl: connectorServerUrlFromHeaders(await headers()),
    remoteRoot: String(formData.get('connectorRemoteRoot') ?? connector.remoteRoot).trim(),
    packageName: connector.packageName,
  });
  const nextConnector = bundle.config;
  const currentConfig = (sandbox.config ?? {}) as Record<string, unknown>;
  const currentInstallCfg = (sandbox.deployment.installCfg ?? {}) as Record<string, unknown>;

  const [, updatedDeployment] = await db.$transaction([
    db.sandbox.update({
      where: { id: sandbox.id },
      data: { config: { ...currentConfig, connector: nextConnector } as Prisma.InputJsonValue },
    }),
    db.deployment.update({
      where: { id: sandbox.deploymentId },
      data: {
        sourceRef: connectorSourceRef(nextConnector),
        installCfg: { ...currentInstallCfg, connector: nextConnector } as Prisma.InputJsonValue,
      },
    }),
  ]);

  disconnectConnector(sandbox.id, 'connector token rotated');
  const status = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
  if (status !== 'running' && status !== 'provisioning') {
    await startProcess(sandbox.deploymentId, resolveSpawnSpec(updatedDeployment), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  }
  await setConnectorSetupTokenCookie(slug, sandbox.id, bundle.token);
  revalidatePath(`/app/${slug}/sandboxes`);
  redirect(`/app/${slug}/sandboxes/${sandbox.id}`);
}

export async function stopSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind === 'hermes') return;
    if (sandboxLifecycleBlocked(sandbox)) return;
    await stopProcess(sandbox.deploymentId);
    if (sandbox.kind === 'connector') disconnectConnector(sandbox.id, 'sandbox stopped');
  });
  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function restartSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
    const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (!sandbox || sandbox.kind === 'hermes') return;
    if (sandboxLifecycleBlocked(sandbox)) return;
    if (sandbox.kind === 'host' || sandbox.kind === 'ssh') return;
    if (sandbox.kind === 'connector' && !connectorFromConfig(sandbox.config)) return;
    await restartProcess(sandbox.deploymentId, resolveSpawnSpec(sandbox.deployment), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  });
  revalidatePath(`/app/${slug}/sandboxes`);
  revalidatePath(`/app/${slug}/sandboxes/${sandboxId}`);
}

export async function deleteSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  let deleted: boolean;
  try {
    deleted = Boolean(await enqueueSandboxOperation(ctx.ws.id, sandboxId, async () => {
      const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
      if (!sandbox || sandbox.kind === 'hermes') return false;

      if (sandbox.kind === 'connector') {
        await stopProcess(sandbox.deploymentId);
        disconnectConnector(sandbox.id, 'sandbox deleted');
      }
      await killProcess(sandbox.deploymentId, {
        preventRestart: true,
        finalStatus: 'deleting',
      });
      await db.deployment.updateMany({
        where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
        data: { status: 'deleting' },
      });
      if (sandbox.kind === 'docker') {
        for (const snapshot of sandbox.snapshots) {
          await removeDockerVolumeStrict(snapshot.volumeName);
        }
        await removeDockerSandboxRuntimeStrict(sandbox.id, sandboxDataVolume(sandbox));
      }
      await db.deployment.deleteMany({
        where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
      });
      return true;
    }));
  } catch (error) {
    const retained = await sandboxInWorkspace(sandboxId, ctx.ws.id);
    if (retained && retained.deployment.status !== 'deleting') {
      allowProcessRestart(retained.deploymentId);
    }
    throw error;
  }
  if (!deleted) return;
  revalidatePath(`/app/${slug}/sandboxes`);
  redirect(`/app/${slug}/sandboxes`);
}
