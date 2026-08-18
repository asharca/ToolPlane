import 'server-only';

import { db } from '@/lib/db';
import { createAgent, deleteAgent } from '@/lib/agents/mutations';
import { resolveHermesImage } from './constants';
import {
  cleanupHermesRuntime,
  copyHermesArchiveToVolume,
  syncHermesRuntime,
} from './runtime';
import {
  HermesArchiveError,
  acquireHermesArchiveImportLock,
  stageHermesArchive,
  type HermesArchiveUpload,
  type StagedHermesArchive,
} from './archive';
import { getHermesArchiveSettings } from '@/lib/admin/settings';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';

export { HermesArchiveError } from './archive';

export type HermesArchiveImportResult = {
  agentId: string;
  sandboxId: string;
};

const HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY = 'hermesArchiveImportRequestId';
const HERMES_ARCHIVE_IMPORT_COMPLETED_CONFIG_KEY = 'hermesArchiveImportCompletedId';

function importedName(raw: string): string {
  return raw.trim().slice(0, 80) || 'Imported Hermes';
}

async function discardFailedImport(workspaceId: string, agentId: string): Promise<boolean> {
  try {
    if (!await cleanupHermesRuntime(workspaceId, agentId)) return false;
    await deleteAgent(workspaceId, agentId);
    return true;
  } catch {
    return false;
  }
}

// A browser may lose the response after the server has already copied a large
// archive. Persisting the client-generated ID only after the copy and initial
// sync succeed lets a retry return that result instead of a second volume.
export async function findHermesArchiveImport(
  workspaceId: string,
  importId: string,
): Promise<
  | { status: 'completed'; result: HermesArchiveImportResult }
  | { status: 'incomplete'; result: HermesArchiveImportResult }
  | null
> {
  const completed = await db.agentRuntime.findFirst({
    where: {
      workspaceId,
      kind: 'hermes',
      sandbox: {
        is: {
          workspaceId,
          kind: 'hermes',
          config: {
            path: [HERMES_ARCHIVE_IMPORT_COMPLETED_CONFIG_KEY],
            equals: importId,
          },
        },
      },
    },
    select: { agentId: true, sandboxId: true },
  });
  if (completed) {
    return {
      status: 'completed',
      result: { agentId: completed.agentId, sandboxId: completed.sandboxId },
    };
  }
  const incomplete = await db.agentRuntime.findFirst({
    where: {
      workspaceId,
      kind: 'hermes',
      sandbox: {
        is: {
          workspaceId,
          kind: 'hermes',
          config: {
            path: [HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY],
            equals: importId,
          },
        },
      },
    },
    select: { agentId: true, sandboxId: true },
  });
  return incomplete
    ? { status: 'incomplete', result: { agentId: incomplete.agentId, sandboxId: incomplete.sandboxId } }
    : null;
}

// An imported Hermes home deliberately becomes an Agent-owned sandbox. A bare
// Sandbox(kind=hermes) cannot be supervised or exposed safely: its runtime
// token, dashboard, terminal, and cleanup lifecycle are AgentRuntime-scoped.
export async function importStagedHermesArchive(params: {
  workspaceId: string;
  name: string;
  staged: StagedHermesArchive;
  image?: string;
  importId?: string;
  allowSudo?: boolean;
}): Promise<HermesArchiveImportResult> {
  const releaseWorkspaceOperation = beginWorkspaceOperation(params.workspaceId);
  if (!releaseWorkspaceOperation) {
    await params.staged.cleanup();
    throw new HermesArchiveError('This workspace is being deleted. Try again after it is available.', 409);
  }

  let agent: { id: string } | null = null;
  let sandboxId = '';
  try {
    if (params.importId) {
      const existing = await findHermesArchiveImport(params.workspaceId, params.importId);
      if (existing?.status === 'completed') return existing.result;
      if (existing) {
        throw new HermesArchiveError(
          'An earlier import with this request ID did not finish. Inspect or remove that sandbox before retrying.',
          409,
        );
      }
    }
    const image = resolveHermesImage(params.image);
    const createdAgent = await createAgent(params.workspaceId, importedName(params.name), {
      runtime: 'hermes',
      hermesImage: image,
      ...(params.allowSudo ? { allowSudo: true } : {}),
    });
    agent = createdAgent;
    const runtime = await db.agentRuntime.findFirst({
      where: { agentId: createdAgent.id, workspaceId: params.workspaceId, kind: 'hermes' },
      select: { sandboxId: true },
    });
    if (!runtime) throw new HermesArchiveError('Could not create the Hermes sandbox.');
    sandboxId = runtime.sandboxId;

    await db.sandbox.updateMany({
      where: { id: sandboxId, workspaceId: params.workspaceId, kind: 'hermes' },
      data: {
        config: {
          managedBy: 'agent-runtime',
          importSource: 'hermes-archive',
          ...(params.allowSudo ? { allowSudo: true } : {}),
          ...(params.importId ? { [HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY]: params.importId } : {}),
        },
      },
    });
    await db.agentRuntime.updateMany({
      where: { agentId: createdAgent.id, workspaceId: params.workspaceId, kind: 'hermes' },
      data: { status: 'copying', lastError: null },
    });
    await db.deployment.updateMany({
      where: {
        sandbox: { is: { id: sandboxId, workspaceId: params.workspaceId } },
        source: 'sandbox',
      },
      data: { status: 'copying' },
    });
    await copyHermesArchiveToVolume({ directory: params.staged.directory, image, sandboxId });
    await db.deployment.updateMany({
      where: {
        sandbox: { is: { id: sandboxId, workspaceId: params.workspaceId } },
        source: 'sandbox',
      },
      data: { status: 'stopped' },
    });
    await db.agentRuntime.updateMany({
      where: { agentId: createdAgent.id, workspaceId: params.workspaceId, kind: 'hermes' },
      data: { status: 'setup_required', lastError: null },
    });
    const syncResult = await syncHermesRuntime(params.workspaceId, createdAgent.id, { start: false });
    if (syncResult.error) {
      throw new HermesArchiveError('Could not prepare the imported Hermes sandbox.');
    }

    if (params.importId) {
      await db.sandbox.updateMany({
        where: { id: sandboxId, workspaceId: params.workspaceId, kind: 'hermes' },
        data: {
          config: {
            managedBy: 'agent-runtime',
            importSource: 'hermes-archive',
            [HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY]: params.importId,
            [HERMES_ARCHIVE_IMPORT_COMPLETED_CONFIG_KEY]: params.importId,
          },
        },
      });
    }

    return { agentId: createdAgent.id, sandboxId };
  } catch (error) {
    const cleaned = agent ? await discardFailedImport(params.workspaceId, agent.id) : true;
    if (!cleaned) {
      throw new HermesArchiveError('Import failed and the stopped runtime was retained for cleanup.');
    }
    if (error instanceof HermesArchiveError) throw error;
    throw new HermesArchiveError('Could not copy the archive into a Hermes sandbox.');
  } finally {
    releaseWorkspaceOperation();
    await params.staged.cleanup();
  }
}

// This compatibility entry point remains for internal callers and focused
// tests. Its HermesArchiveUpload type is streaming-only; browser imports use
// the raw-body route and hold the same cross-process staging lock.
export async function importHermesArchive(params: {
  workspaceId: string;
  name: string;
  archive: HermesArchiveUpload;
  image?: string;
}): Promise<HermesArchiveImportResult> {
  const settings = await getHermesArchiveSettings();
  const importLock = await acquireHermesArchiveImportLock();
  if (!importLock) {
    throw new HermesArchiveError('Another Hermes archive import is in progress. Try again after it finishes.', 409);
  }
  let staged: StagedHermesArchive | null = null;
  try {
    await importLock.assertHeld();
    staged = await stageHermesArchive(params.archive, {
      maxUploadMiB: settings.hermesArchiveMaxUploadMiB,
      ...(importLock.stagingToken ? { stagingToken: importLock.stagingToken } : {}),
    });
    await importLock.assertHeld();
    const stagedForImport = staged;
    staged = null;
    return await importStagedHermesArchive({
      workspaceId: params.workspaceId,
      name: params.name,
      staged: stagedForImport,
      image: params.image,
    });
  } finally {
    if (staged) await staged.cleanup().catch(() => undefined);
    await importLock.release().catch(() => undefined);
  }
}
