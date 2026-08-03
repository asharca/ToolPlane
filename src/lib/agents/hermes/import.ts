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
  stageHermesArchive,
  type HermesArchiveUpload,
} from './archive';
import { getSystemSettings } from '@/lib/admin/settings';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';

export { HermesArchiveError } from './archive';
export { isHermesArchiveUpload } from './archive';

export type HermesArchiveImportResult = {
  agentId: string;
  sandboxId: string;
};

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

// An imported Hermes home deliberately becomes an Agent-owned sandbox. A bare
// Sandbox(kind=hermes) cannot be supervised or exposed safely: its runtime
// token, dashboard, terminal, and cleanup lifecycle are AgentRuntime-scoped.
export async function importHermesArchive(params: {
  workspaceId: string;
  name: string;
  archive: HermesArchiveUpload;
  image?: string;
}): Promise<HermesArchiveImportResult> {
  const settings = await getSystemSettings();
  const staged = await stageHermesArchive(params.archive, {
    maxUploadMiB: settings.hermesArchiveMaxUploadMiB,
  });
  const releaseWorkspaceOperation = beginWorkspaceOperation(params.workspaceId);
  if (!releaseWorkspaceOperation) {
    await staged.cleanup();
    throw new HermesArchiveError('This workspace is being deleted. Try again after it is available.');
  }

  let agent: { id: string } | null = null;
  let sandboxId = '';
  try {
    const image = resolveHermesImage(params.image);
    const createdAgent = await createAgent(params.workspaceId, importedName(params.name), {
      runtime: 'hermes',
      hermesImage: image,
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
    await copyHermesArchiveToVolume({ directory: staged.directory, image, sandboxId });
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
    await staged.cleanup();
  }
}
