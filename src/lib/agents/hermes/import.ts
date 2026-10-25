import "server-only";

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { deleteAgent } from "@/lib/agents/mutations";
import { sandboxVolumeName } from "@/lib/sandboxes/runtime";
import { resolveHermesImage } from "./constants";
import { cleanupHermesRuntime } from "./runtime";
import { copyHermesArchiveToVolume } from "./archive-storage";
import { HermesArchiveError, type StagedHermesArchive } from "./archive";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";

export { HermesArchiveError } from "./archive";

export type HermesArchiveImportResult = {
  agentId: string;
  sandboxId: string;
};

const HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY = "hermesArchiveImportRequestId";
const HERMES_ARCHIVE_IMPORT_COMPLETED_CONFIG_KEY =
  "hermesArchiveImportCompletedId";

function importedName(raw: string): string {
  return raw.trim().slice(0, 80) || "Imported Hermes";
}

async function discardFailedImport(
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  try {
    if (!(await cleanupHermesRuntime(workspaceId, agentId))) return false;
    await deleteAgent(workspaceId, agentId);
    return true;
  } catch {
    return false;
  }
}

// Request markers make archive storage idempotent even if the browser disconnects.
// Imported Agents are retired history; no runtime projection or execution occurs.
export async function findHermesArchiveImport(
  workspaceId: string,
  importId: string,
): Promise<
  | { status: "completed"; result: HermesArchiveImportResult }
  | { status: "incomplete"; result: HermesArchiveImportResult }
  | null
> {
  const completed = await db.agentRuntime.findFirst({
    where: {
      workspaceId,
      kind: "hermes",
      sandbox: {
        is: {
          workspaceId,
          kind: "hermes",
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
      status: "completed",
      result: { agentId: completed.agentId, sandboxId: completed.sandboxId },
    };
  }
  const incomplete = await db.agentRuntime.findFirst({
    where: {
      workspaceId,
      kind: "hermes",
      sandbox: {
        is: {
          workspaceId,
          kind: "hermes",
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
    ? {
        status: "incomplete",
        result: {
          agentId: incomplete.agentId,
          sandboxId: incomplete.sandboxId,
        },
      }
    : null;
}

// Keep legacy archive files accessible under their historical identity without
// creating an executable Hermes Agent or pretending its sessions are resumable.
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
    throw new HermesArchiveError(
      "This workspace is being deleted. Try again after it is available.",
      409,
    );
  }

  let agent: { id: string } | null = null;
  let sandboxId = "";
  try {
    if (params.importId) {
      const existing = await findHermesArchiveImport(
        params.workspaceId,
        params.importId,
      );
      if (existing?.status === "completed") return existing.result;
      if (existing) {
        throw new HermesArchiveError(
          "An earlier import with this request ID did not finish. Inspect or remove that sandbox before retrying.",
          409,
        );
      }
    }
    const image = resolveHermesImage(params.image);
    const createdAgent = await db.$transaction(async (tx) => {
      const slug = `hermes-history-${randomUUID()}`;
      const historical = await tx.agent.create({
        data: {
          workspaceId: params.workspaceId,
          name: importedName(params.name),
          slug,
          runtimeKind: "hermes",
          retiredAt: new Date(),
        },
      });
      const deployment = await tx.deployment.create({
        data: {
          workspaceId: params.workspaceId,
          name: `Historical archive: ${historical.name}`,
          source: "sandbox",
          sourceRef: image,
          status: "stopped",
        },
      });
      const sandbox = await tx.sandbox.create({
        data: {
          workspaceId: params.workspaceId,
          deploymentId: deployment.id,
          name: `${historical.name} Archive`,
          slug,
          kind: "hermes",
          image,
          network: "none",
          config: {
            managedBy: "historical-archive",
            importSource: "hermes-archive",
            readOnly: true,
          },
        },
      });
      const runtime = await tx.agentRuntime.create({
        data: {
          workspaceId: params.workspaceId,
          agentId: historical.id,
          sandboxId: sandbox.id,
          kind: "hermes",
          image,
          status: "stopped",
        },
      });
      await tx.deployment.update({
        where: { id: deployment.id },
        data: {
          installCfg: {
            sandboxId: sandbox.id,
            runtimeId: runtime.id,
            kind: "hermes",
            image,
            network: "none",
            volumeName: sandboxVolumeName(sandbox.id),
            env: {},
            readOnly: true,
          },
        },
      });
      return historical;
    });
    agent = createdAgent;
    const runtime = await db.agentRuntime.findFirst({
      where: {
        agentId: createdAgent.id,
        workspaceId: params.workspaceId,
        kind: "hermes",
      },
      select: { sandboxId: true },
    });
    if (!runtime)
      throw new HermesArchiveError("Could not create the Hermes sandbox.");
    sandboxId = runtime.sandboxId;

    await db.sandbox.updateMany({
      where: { id: sandboxId, workspaceId: params.workspaceId, kind: "hermes" },
      data: {
        config: {
          managedBy: "historical-archive",
          importSource: "hermes-archive",
          readOnly: true,
          ...(params.importId
            ? { [HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY]: params.importId }
            : {}),
        },
      },
    });
    await db.agentRuntime.updateMany({
      where: {
        agentId: createdAgent.id,
        workspaceId: params.workspaceId,
        kind: "hermes",
      },
      data: { status: "copying", lastError: null },
    });
    await db.deployment.updateMany({
      where: {
        sandbox: { is: { id: sandboxId, workspaceId: params.workspaceId } },
        source: "sandbox",
      },
      data: { status: "copying" },
    });
    await copyHermesArchiveToVolume({
      directory: params.staged.directory,
      image,
      sandboxId,
    });
    await db.deployment.updateMany({
      where: {
        sandbox: { is: { id: sandboxId, workspaceId: params.workspaceId } },
        source: "sandbox",
      },
      data: { status: "stopped" },
    });
    await db.agentRuntime.updateMany({
      where: {
        agentId: createdAgent.id,
        workspaceId: params.workspaceId,
        kind: "hermes",
      },
      data: { status: "stopped", lastError: null },
    });

    if (params.importId) {
      await db.sandbox.updateMany({
        where: {
          id: sandboxId,
          workspaceId: params.workspaceId,
          kind: "hermes",
        },
        data: {
          config: {
            managedBy: "historical-archive",
            importSource: "hermes-archive",
            readOnly: true,
            [HERMES_ARCHIVE_IMPORT_REQUEST_CONFIG_KEY]: params.importId,
            [HERMES_ARCHIVE_IMPORT_COMPLETED_CONFIG_KEY]: params.importId,
          },
        },
      });
    }

    return { agentId: createdAgent.id, sandboxId };
  } catch (error) {
    const cleaned = agent
      ? await discardFailedImport(params.workspaceId, agent.id)
      : true;
    if (!cleaned) {
      throw new HermesArchiveError(
        "Import failed and the stopped runtime was retained for cleanup.",
      );
    }
    if (error instanceof HermesArchiveError) throw error;
    throw new HermesArchiveError(
      "Could not copy the archive into a Hermes sandbox.",
    );
  } finally {
    releaseWorkspaceOperation();
    await params.staged.cleanup();
  }
}
