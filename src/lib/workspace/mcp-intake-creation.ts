import "server-only";
import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { withLogContext } from "@/lib/observability/context";
import { logSystemEvent } from "@/lib/observability/system";
import { listMcpTools } from "@/lib/process/mcp-client";
import {
  resolveMcpConnectionSpawnSpec,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import {
  McpPinningError,
  resolvePinnedMcpRecipe,
} from "@/lib/process/mcp-pinning";
import { startProcess } from "@/lib/process/supervisor";
import { encryptSecretText } from "@/lib/security/secrets";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { startUrl } from "@/lib/remote-mcp/oauth/protocol";
import { isPackagedStdioCommand } from "@/lib/process/mcp-runtime-target";
import { beginWorkspaceOperation } from "./operation-gate";
import { hasCredentialEcho, resolvedMcpLock } from "./mcp-config";
import { IntakeError, applyCreateItem, type IntakeEntry } from "./mcp-intake";
import type {
  McpIntakeCreateItem,
  McpIntakeCreateResult,
} from "./mcp-intake-types";
import {
  parseRuntimeTextFiles,
  runtimeFilePathKey,
  type ValidRuntimeTextFile,
} from "./runtime-files";
import { workspaceScopeWhere, type WorkspaceScope } from "./scope";

export function mcpProcessOptions(
  ctx: { user: { id: string }; ws: { id: string } },
  deploymentId: string,
) {
  return {
    awaitReady: false,
    workspaceId: ctx.ws.id,
    onReady: () =>
      withLogContext(
        { workspaceId: ctx.ws.id, deploymentId, actorId: ctx.user.id },
        async () => {
          await listMcpTools(deploymentId);
        },
      ),
  };
}

type CreationContext = { ws: WorkspaceScope; user: { id: string } };
type PreparedDeployment = {
  data: Prisma.DeploymentCreateInput;
  revision: Prisma.McpConfigRevisionCreateWithoutDeploymentInput;
  status: "setup_required" | "provisioning";
  startOAuth: boolean;
};

async function prepareDeployment(
  ctx: CreationContext,
  entry: IntakeEntry,
  item: McpIntakeCreateItem,
  allowHttp: boolean,
): Promise<PreparedDeployment> {
  if (
    entry.draft.kind === "stdio" &&
    !isPackagedStdioCommand(JSON.parse(entry.draft.config).command) &&
    !ctx.ws.permissions.includes("resources")
  )
    throw new IntakeError("arbitraryCommandNotAllowed");
  const { status, name, source, ref, installCfg } = applyCreateItem(
    entry,
    item,
    allowHttp,
  );
  if (
    hasCredentialEcho(
      entry.document,
      JSON.parse(entry.draft.config),
      Object.entries(installCfg.env)
        .filter(([key]) => !Object.hasOwn(entry.publicEnv, key))
        .map(([, value]) => value),
    )
  )
    throw new IntakeError("invalidConfig");
  let files: ValidRuntimeTextFile[];
  try {
    files = parseRuntimeTextFiles(JSON.stringify(item.runtimeFiles));
    if (entry.draft.kind !== "stdio" && files.length) throw new Error();
  } catch {
    throw new IntakeError("invalidRuntimeFile");
  }
  const missingFile = entry.draft.files?.find(
    (required) =>
      !files.some(
        (file) =>
          file.path === required.path ||
          file.path.startsWith(`${required.path}/`),
      ),
  );
  if (missingFile) throw new IntakeError("runtimeFileRequired");
  const sealed = sealMcpEnvironment(installCfg, ctx.ws.id, installCfg.env);
  const pinned = await resolvePinnedMcpRecipe({
    source,
    sourceRef: ref,
    installCfg: sealed,
  });
  const configFiles = files.map((file) => ({
    path: file.path,
    pathKey: runtimeFilePathKey(file.path),
    size: file.size,
    encryptedContent: encryptSecretText(file.content) as Prisma.InputJsonValue,
  }));
  return {
    status,
    revision: {
      revision: 1,
      document: entry.document,
      format: entry.draft.origin === "json" ? "mcp-json" : entry.draft.origin,
      resolved: resolvedMcpLock(pinned),
      createdById: ctx.user.id,
    },
    startOAuth:
      item.authMode === "oauth" &&
      entry.draft.auth.type === "oauth" &&
      entry.draft.auth.client !== "missing",
    data: {
      workspace: { connect: { id: ctx.ws.id } },
      name,
      source,
      sourceRef: pinned.sourceRef,
      installCfg: pinned.installCfg as Prisma.InputJsonValue,
      status,
      ...(configFiles.length ? { configFiles: { create: configFiles } } : {}),
    },
  };
}

export async function createIntakeDeployments(
  ctx: CreationContext,
  entries: IntakeEntry[],
  items: McpIntakeCreateItem[],
): Promise<McpIntakeCreateResult> {
  const release = beginWorkspaceOperation(ctx.ws.id);
  if (!release) return { ok: false, error: "connectionCreateFailed" };
  try {
    return await createUnderOwner(ctx, entries, items);
  } finally {
    release();
  }
}

async function createUnderOwner(
  ctx: CreationContext,
  entries: IntakeEntry[],
  items: McpIntakeCreateItem[],
): Promise<McpIntakeCreateResult> {
  if (!Array.isArray(items) || !items.length || items.length > 20)
    return { ok: false, error: "invalidConfig" };
  const { allowHttp } = await getTransportSettings();
  const seen = new Set<string>();
  const prepared: PreparedDeployment[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !/^\d{1,2}$/.test(item.id))
      return { ok: false, error: "itemNotFound" };
    const entry = entries.find((candidate) => candidate.draft.id === item.id);
    if (!entry || seen.has(item.id))
      return { ok: false, error: "itemNotFound", itemId: item.id };
    seen.add(item.id);
    try {
      prepared.push(await prepareDeployment(ctx, entry, item, allowHttp));
    } catch (error) {
      const code =
        error instanceof IntakeError || error instanceof McpPinningError
          ? error.code
          : "connectionCreateFailed";
      return { ok: false, error: code, itemId: item.id };
    }
  }
  // All validation, pinning and encryption complete before the first insert.
  const deployments = await db.$transaction(async (tx) => {
    const created: Array<{
      id: string;
      status: "setup_required" | "provisioning" | "error";
      oauthStartUrl?: string;
    }> = [];
    for (const { status, data, startOAuth, revision } of prepared) {
      const { id } = await tx.deployment.create({ data, select: { id: true } });
      const active = await tx.mcpConfigRevision.create({
        data: { ...revision, deploymentId: id },
        select: { id: true },
      });
      await tx.deployment.update({
        where: { id, workspace: workspaceScopeWhere(ctx.ws) },
        data: { activeRevisionId: active.id },
      });
      created.push({
        id,
        status,
        ...(startOAuth && { oauthStartUrl: startUrl(ctx.ws.slug, id) }),
      });
    }
    return created;
  });
  for (const dep of deployments) {
    if (dep.status !== "provisioning") continue;
    try {
      const { spec } = await resolveMcpConnectionSpawnSpec({
        workspaceId: ctx.ws.id,
        deploymentId: dep.id,
      });
      await startProcess(dep.id, spec, mcpProcessOptions(ctx, dep.id));
    } catch {
      dep.status = "error";
      logSystemEvent("mcp.deployment.start_failed", {
        domain: "mcp",
        workspaceId: ctx.ws.id,
        deploymentId: dep.id,
        actorId: ctx.user.id,
      });
      try {
        await db.deployment.updateMany({
          where: {
            id: dep.id,
            workspace: workspaceScopeWhere(ctx.ws),
            status: "provisioning",
          },
          data: { status: "error" },
        });
      } catch {
        logSystemEvent("mcp.deployment.status_persist_failed", {
          domain: "mcp",
          workspaceId: ctx.ws.id,
          deploymentId: dep.id,
          actorId: ctx.user.id,
        });
      }
    }
  }
  revalidatePath(`/app/${ctx.ws.slug}/mcp`);
  return { ok: true, deployments };
}
