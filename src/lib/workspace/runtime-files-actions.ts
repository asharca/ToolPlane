'use server';

import type { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { restartProcess } from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { decryptSecretText, encryptSecretText } from '@/lib/security/secrets';
import {
  EDITABLE_MCP_SOURCES,
} from '@/lib/workspace/custom-mcp';
import {
  MAX_RUNTIME_TEXT_FILES,
  MAX_RUNTIME_TEXT_FILES_BYTES,
  safeRuntimeFilePath,
  runtimeFilePathKey,
  validateRuntimeTextFiles,
} from '@/lib/workspace/runtime-files';

export type RuntimeFileMetadata = {
  id: string;
  path: string;
  size: number;
  updatedAt: string;
};

export type RuntimeFilesActionState = {
  error?: 'invalidFile' | 'notAuthorized' | 'deploymentNotFound' | 'fileNotFound' | 'saveFailed' | 'restartFailed';
  savedAt?: number;
  file?: RuntimeFileMetadata;
};

class RuntimeFileLimitError extends Error {}

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  return ws ? { user, ws } : null;
}

async function editableDeployment(deploymentId: string, workspaceId: string) {
  return db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId,
      source: { in: [...EDITABLE_MCP_SOURCES] },
    },
    include: { server: { select: { name: true } } },
  });
}

function metadata(file: { id: string; path: string; size: number; updatedAt: Date }): RuntimeFileMetadata {
  return {
    id: file.id,
    path: file.path,
    size: file.size,
    updatedAt: file.updatedAt.toISOString(),
  };
}

function revalidateDeploymentPaths(workspace: string, deploymentId: string) {
  revalidatePath(`/app/${workspace}/mcp`);
  revalidatePath(`/app/${workspace}/mcp/${deploymentId}`);
}

export async function revealDeploymentRuntimeFileAction({
  workspace,
  deploymentId,
  fileId,
}: {
  workspace: string;
  deploymentId: string;
  fileId: string;
}): Promise<{ path?: string; content?: string; error?: 'notAuthorized' | 'deploymentNotFound' | 'fileNotFound' }> {
  const ctx = await authorizedWorkspace(workspace);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await editableDeployment(deploymentId, ctx.ws.id);
  if (!deployment) return { error: 'deploymentNotFound' };
  const file = await db.deploymentConfigFile.findFirst({
    where: { id: fileId, deploymentId: deployment.id },
    select: { path: true, encryptedContent: true },
  });
  if (!file) return { error: 'fileNotFound' };
  try {
    return { path: file.path, content: decryptSecretText(file.encryptedContent) };
  } catch {
    // A corrupted or differently-keyed secret must not be reflected to a
    // client. The user can replace the file to restore the deployment.
    return { error: 'fileNotFound' };
  }
}

export async function upsertDeploymentRuntimeFileAction(
  _previous: RuntimeFilesActionState,
  formData: FormData,
): Promise<RuntimeFilesActionState> {
  const workspace = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const pathEntry = formData.get('path');
  const path = typeof pathEntry === 'string' ? safeRuntimeFilePath(pathEntry) : null;
  const content = formData.get('content');
  if (!workspace || !deploymentId || !path || typeof content !== 'string') {
    return { error: 'invalidFile' };
  }

  let file;
  try {
    file = validateRuntimeTextFiles([{ path, content }])[0];
  } catch {
    return { error: 'invalidFile' };
  }
  if (!file) return { error: 'invalidFile' };
  const ctx = await authorizedWorkspace(workspace);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await editableDeployment(deploymentId, ctx.ws.id);
  if (!deployment) return { error: 'deploymentNotFound' };

  const pathKey = runtimeFilePathKey(file.path);
  let stored;
  try {
    stored = await db.$transaction(async (tx) => {
      const current = await tx.deploymentConfigFile.findMany({
        where: { deploymentId: deployment.id },
        select: { pathKey: true, size: true },
      });
      const replacing = current.find((existing) => existing.pathKey === pathKey);
      if (current.length + (replacing ? 0 : 1) > MAX_RUNTIME_TEXT_FILES) {
        throw new RuntimeFileLimitError('Too many runtime files.');
      }
      const totalBytes = current.reduce((total, existing) => total + existing.size, 0)
        - (replacing?.size ?? 0)
        + file.size;
      if (totalBytes > MAX_RUNTIME_TEXT_FILES_BYTES) {
        throw new RuntimeFileLimitError('Runtime files are too large.');
      }
      return tx.deploymentConfigFile.upsert({
        where: { deploymentId_pathKey: { deploymentId: deployment.id, pathKey } },
        update: {
          path: file.path,
          encryptedContent: encryptSecretText(file.content) as Prisma.InputJsonValue,
          size: file.size,
        },
        create: {
          deploymentId: deployment.id,
          path: file.path,
          pathKey,
          encryptedContent: encryptSecretText(file.content) as Prisma.InputJsonValue,
          size: file.size,
        },
        select: { id: true, path: true, size: true, updatedAt: true },
      });
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof RuntimeFileLimitError) return { error: 'invalidFile' };
    return { error: 'saveFailed' };
  }

  try {
    await restartProcess(deployment.id, resolveSpawnSpec(deployment), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  } catch {
    revalidateDeploymentPaths(workspace, deploymentId);
    return { error: 'restartFailed' };
  }
  revalidateDeploymentPaths(workspace, deploymentId);
  return { savedAt: Date.now(), file: metadata(stored) };
}

export async function deleteDeploymentRuntimeFileAction(
  formData: FormData,
): Promise<RuntimeFilesActionState> {
  const workspace = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const fileId = String(formData.get('fileId') ?? '');
  if (!workspace || !deploymentId || !fileId) return { error: 'fileNotFound' };
  const ctx = await authorizedWorkspace(workspace);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await editableDeployment(deploymentId, ctx.ws.id);
  if (!deployment) return { error: 'deploymentNotFound' };

  let removed;
  try {
    removed = await db.deploymentConfigFile.deleteMany({
      where: { id: fileId, deploymentId: deployment.id },
    });
  } catch {
    return { error: 'saveFailed' };
  }
  if (!removed.count) return { error: 'fileNotFound' };

  try {
    await restartProcess(deployment.id, resolveSpawnSpec(deployment), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  } catch {
    revalidateDeploymentPaths(workspace, deploymentId);
    return { error: 'restartFailed' };
  }
  revalidateDeploymentPaths(workspace, deploymentId);
  return { savedAt: Date.now() };
}
