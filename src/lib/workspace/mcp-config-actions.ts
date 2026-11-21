"use server";

import type { Deployment, McpConfigRevision, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { db } from "@/lib/db";
import {
  resolveMcpConnectionSpawnSpec,
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import {
  McpPinningError,
  resolvePinnedMcpRecipe,
} from "@/lib/process/mcp-pinning";
import {
  isPackagedStdioCommand,
  validateMcpRuntimeTarget,
} from "@/lib/process/mcp-runtime-target";
import {
  killProcess,
  restartProcess,
  stopProcess,
} from "@/lib/process/supervisor";
import { isOAuthConfig } from "@/lib/remote-mcp/oauth/config";
import { isExternalSandboxCandidate } from "@/lib/sandboxes/external";
import { actionScope } from "./action-scope";
import { EDITABLE_MCP_SOURCES } from "./custom-mcp";
import {
  deriveMcpInstallCfg,
  hasCredentialEcho,
  mcpDocumentDiff,
  migratedMcpDocument,
  record,
  resolvedMcpLock,
  splitMcpDocument,
  variableKey,
} from "./mcp-config";
import type {
  McpConfigErrorCode,
  McpConfigFailure,
  McpConfigFormat,
  McpConfigPreview,
  McpConfigSaveResult,
  McpConfigView,
  McpRuntimeTarget,
} from "./mcp-config-types";
import { analyzeEntry, IntakeError, parseCanonical } from "./mcp-intake";
import { mcpProcessOptions } from "./mcp-intake-creation";
import { runMcpDeploymentOperation } from "./mcp-operation";
import { workspaceScopeWhere, type WorkspaceScope } from "./scope";
import { parseServerRecipe } from "./server-recipe";

type Target = { workspace: string; deploymentId: string };
type DocumentInput = Target & { document: string };
type Variables = { values: Record<string, string>; remove?: string[] };
type Change =
  | { kind: "document"; document: string; values?: Record<string, string> }
  | ({ kind: "variables" } & Variables)
  | { kind: "rollback"; revisionId: string }
  | { kind: "dependencies" }
  | { kind: "runtime"; target: McpRuntimeTarget; sandboxId?: string | null };
type Snapshot = Pick<McpConfigRevision, "document" | "format" | "resolved">;
type Row = Prisma.DeploymentGetPayload<{
  include: {
    server: { select: { installCfg: true } };
    mcpOAuthCredential: { select: { status: true } };
  };
}>;
class ConfigError extends Error {
  constructor(readonly code: McpConfigErrorCode) {
    super(code);
  }
}
function fail(code: McpConfigErrorCode): never {
  throw new ConfigError(code);
}
function failure(e: unknown): McpConfigFailure {
  return {
    ok: false,
    error:
      e instanceof ConfigError || e instanceof McpPinningError
        ? e.code
        : e instanceof IntakeError
          ? "invalidConfig"
          : "saveFailed",
  };
}
function where(ws: WorkspaceScope, id: string) {
  if (typeof id !== "string" || !id) fail("notFound");
  return {
    id,
    workspace: workspaceScopeWhere(ws),
    source: { in: [...EDITABLE_MCP_SOURCES] },
  };
}
async function load(
  ws: WorkspaceScope,
  id: string,
  client: Prisma.TransactionClient = db,
) {
  const row = await client.deployment.findFirst({
    where: where(ws, id),
    include: {
      server: { select: { installCfg: true } },
      mcpOAuthCredential: { select: { status: true } },
    },
  });
  if (!row) fail("notFound");
  return row;
}
function parseEntry(text: string, dep: Deployment) {
  try {
    const entries = splitMcpDocument(text);
    if (entries.length !== 1) fail("invalidConfig");
    const [entry] = entries;
    return analyzeEntry(
      entry.config,
      dep.name ?? entry.name ?? "MCP",
      "json",
      "0",
      entry.text,
    );
  } catch {
    return fail("invalidConfig");
  }
}

// Only migrate plaintext key/value seeds in a legacy row which has no envelope. Never fall back when scope validation or decryption fails.
function previousEnvironment(
  dep: Deployment,
  workspaceId: string,
): Record<string, string> {
  const cfg = record(dep.installCfg);
  if (!dep.activeRevisionId && !cfg.credentialEnvelope) {
    const env = cfg.env ?? {};
    validatePatch(env, []);
    return env as Record<string, string>;
  }
  return resolveMcpEnvironment(cfg, workspaceId);
}
function legacySnapshot(dep: Deployment) {
  const entry = parseEntry(migratedMcpDocument(dep), dep);
  const config = JSON.parse(entry.draft.config);
  return {
    document: entry.document,
    format: "migrated",
    resolved: resolvedMcpLock({
      sourceRef: config.command ?? config.url,
      installCfg: config,
    }),
    literals: entry.literals,
  };
}
async function snapshot(
  ws: WorkspaceScope,
  dep: Deployment,
  tx: Prisma.TransactionClient = db,
): Promise<Snapshot> {
  if (!dep.activeRevisionId) return legacySnapshot(dep);
  return (
    (await tx.mcpConfigRevision.findFirst({
      where: {
        id: dep.activeRevisionId,
        deploymentId: dep.id,
        deployment: { workspace: workspaceScopeWhere(ws) },
      },
    })) ?? fail("notFound")
  );
}
/** Serialize first-read backfill and revision numbering across DB connections. Always reauthorize after taking the lock. */
async function locked(
  ws: WorkspaceScope,
  id: string,
  tx: Prisma.TransactionClient,
) {
  await tx.$queryRaw`SELECT id FROM "Deployment" WHERE id = ${id} AND "workspaceId" = ${ws.id} FOR UPDATE`;
  return load(ws, id, tx);
}
async function backfill(
  ws: WorkspaceScope,
  dep: Row,
  tx: Prisma.TransactionClient,
) {
  if (dep.activeRevisionId) return dep;
  const { literals, ...seed } = legacySnapshot(dep);
  let migrated: Prisma.InputJsonValue | undefined;
  const oldEnv = previousEnvironment(dep, ws.id);
  if (
    Object.keys(literals).length ||
    (!record(dep.installCfg).credentialEnvelope &&
      Object.values(oldEnv).some(Boolean))
  ) {
    // Old argv/startCommand can carry literals even when its env was already sealed.
    const env = { ...oldEnv, ...literals };
    const args = seed.resolved.args ?? [];
    migrated = sealMcpEnvironment(
      {
        ...record(dep.installCfg),
        ...(dep.source === "docker"
          ? { startCommand: args.slice(4).join(" ") }
          : dep.source === "config"
            ? { args }
            : {}),
      },
      ws.id,
      env,
    ) as Prisma.InputJsonObject;
  }
  const active = await tx.mcpConfigRevision.create({
    data: { ...seed, deploymentId: dep.id, revision: 1 },
  });
  await tx.deployment.update({
    where: where(ws, dep.id),
    data: {
      activeRevisionId: active.id,
      ...(migrated && { installCfg: migrated }),
    },
  });
  return load(ws, dep.id, tx);
}

function validatePatch(values: unknown, remove: unknown) {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !Array.isArray(remove)
  )
    fail("invalidConfig");
  if (Object.keys(values).length > 100 || remove.length > 100)
    fail("invalidConfig");
  for (const [key, value] of Object.entries(values)) {
    if (
      !variableKey(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > 16000
    )
      fail("invalidConfig");
  }
  if (remove.some((key) => typeof key !== "string" || !variableKey(key)))
    fail("invalidConfig");
}
async function plan(
  ws: WorkspaceScope,
  dep: Row,
  text: string,
  values: Record<string, string> = {},
  remove: string[] = [],
) {
  validatePatch(values, remove);
  const entry = parseEntry(text, dep);
  const remote = dep.source === "remote";
  if ((entry.draft.kind === "remote") !== remote) fail("kindChangeNotAllowed");
  const canonical = JSON.parse(entry.draft.config);
  if (
    !remote &&
    !isPackagedStdioCommand(canonical.command) &&
    ws.role === "member"
  )
    fail("arbitraryCommandNotAllowed");
  const previous = record(dep.installCfg);
  const { allowHttp } = await getTransportSettings();
  const allowUnsafeHttp =
    previous.allowUnsafeHttp === true && canonical.url === dep.sourceRef;
  if (entry.draft.insecureHttp && !allowHttp && !allowUnsafeHttp)
    fail("invalidConfig");
  const parsed = parseCanonical(canonical, dep.name ?? "MCP", {
    allowHttp,
    allowUnsafeHttp,
  });
  if (!parsed.installCfg) fail("invalidConfig");
  const cfg = record(parsed.installCfg);
  const packageCatalog = !!dep.serverId && !remote && dep.source !== "config";
  if (packageCatalog) {
    const original = JSON.parse(migratedMcpDocument(dep));
    if (
      cfg.command !== original.command ||
      JSON.stringify(cfg.args) !== JSON.stringify(original.args)
    )
      fail("invalidConfig");
  } else if (dep.serverId && parsed.ref !== dep.sourceRef)
    fail("invalidConfig");
  const injected = dep.activeRevisionId ? {} : legacySnapshot(dep).literals;
  // Deleting a literal from the document also removes it from the child environment.
  const inherited = previousEnvironment(dep, ws.id);
  if (Array.isArray(previous.documentEnvKeys)) {
    for (const key of previous.documentEnvKeys)
      if (typeof key === "string") delete inherited[key];
  }
  // Rows created before public literals were distinguished can still have an
  // ordinary value stored under its own variable name. Reclassify that exact
  // binding, not a different variable containing the same credential.
  for (const [key, value] of Object.entries(entry.publicEnv)) {
    if (inherited[key] === value) delete inherited[key];
  }
  const env = {
    ...inherited,
    ...injected,
    ...entry.literals,
    ...values,
  };
  if (
    ws.capability === "manage" &&
    hasCredentialEcho(entry.document, entry.draft, Object.values(env))
  )
    fail("invalidConfig");
  for (const key of remove) delete env[key];
  Object.assign(env, entry.publicEnv);
  const required = [
    ...new Set([
      ...entry.draft.fields
        .filter((field) => field.required)
        .map((field) => field.key),
      ...Object.keys(entry.literals),
      ...(parseServerRecipe(dep.server?.installCfg)?.env ?? []),
    ]),
  ];
  for (const key of required) env[key] ??= "";
  if (
    Object.keys(env).length > 100 ||
    Object.entries(env).reduce((sum, [k, v]) => sum + k.length + v.length, 0) >
      64000
  )
    fail("invalidConfig");
  if (remote) {
    // Authorization alongside custom headers stores the scheme as part of the header value.
    const bearer = entry.bearerKey;
    if (bearer && env[bearer]) {
      const token = env[bearer].trim().replace(/^Bearer\s+/i, "");
      env[bearer] = cfg.authType === "headers" ? `Bearer ${token}` : token;
    }
    const headerKeys = [
      ...Object.values(record(cfg.headerEnv)),
      cfg.bearerEnv,
    ].filter((k): k is string => typeof k === "string");
    if (
      headerKeys.some(
        (k) => env[k] && (env[k].length > 8192 || /[\r\n\0]/.test(env[k])),
      )
    )
      fail("invalidConfig");
  }
  const wasOAuth = isOAuthConfig(previous);
  const keepOAuth = wasOAuth && cfg.authType === "none";
  const revokeOAuth =
    wasOAuth && (!keepOAuth || new URL(parsed.ref).href !== previous.resource);
  if (keepOAuth)
    Object.assign(cfg, {
      authType: "oauth",
      resource: new URL(parsed.ref).href,
      issuer: revokeOAuth ? null : previous.issuer,
    });
  if (Object.keys(entry.publicEnv).length)
    cfg.documentEnvKeys = Object.keys(entry.publicEnv);
  const installCfg = sealMcpEnvironment(
    deriveMcpInstallCfg(previous, cfg, entry.envBindings, required),
    ws.id,
    env,
  );
  const missing = required.filter((key) => !env[key]?.trim());
  const status =
    missing.length ||
    (keepOAuth && (revokeOAuth || dep.mcpOAuthCredential?.status !== "active"))
      ? ("setup_required" as const)
      : ("provisioning" as const);
  return {
    entry,
    source: packageCatalog ? dep.source : parsed.source,
    sourceRef: packageCatalog
      ? (dep.sourceRef ?? fail("invalidConfig"))
      : parsed.ref,
    installCfg,
    missing,
    status,
    revokeOAuth,
  };
}

export async function getMcpConfigAction(
  input: Target,
): Promise<{ ok: true; view: McpConfigView } | McpConfigFailure> {
  try {
    const ctx = await actionScope({ slug: input.workspace });
    if (!ctx) fail("notAuthorized");
    const ws = ctx.ws;
    let dep = await load(ws, input.deploymentId);
    if (!dep.activeRevisionId)
      dep = await db.$transaction(async (tx) =>
        backfill(ws, await locked(ws, input.deploymentId, tx), tx),
      );
    if (!dep.activeRevisionId) fail("saveFailed");
    const [active, history, sandboxes] = await Promise.all([
      snapshot(ws, dep),
      db.mcpConfigRevision.findMany({
        where: {
          deploymentId: dep.id,
          deployment: { workspace: workspaceScopeWhere(ws) },
        },
        select: {
          id: true,
          revision: true,
          format: true,
          createdAt: true,
          createdById: true,
        },
        orderBy: { revision: "desc" },
      }),
      db.sandbox.findMany({
        where: {
          workspace: workspaceScopeWhere(ws),
          deployment: { source: "sandbox", status: "running" },
          agentLinks: { none: {} },
        },
        select: { id: true, name: true, kind: true, config: true },
        orderBy: { name: "asc" },
      }),
    ]);
    const authors = await db.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              history.flatMap((r) => (r.createdById ? [r.createdById] : [])),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const names = new Map(authors.map((a) => [a.id, a.name]));
    const entry = parseEntry(active.document, dep);
    const env = record(record(dep.installCfg).env);
    const configured = record(
      record(dep.installCfg).credentialEnvelope,
    ).configuredKeys;
    const required = record(dep.installCfg).requiredEnv;
    const canManage = ws.role !== "member";
    const lock = record(active.resolved);
    return {
      ok: true,
      view: {
        deploymentId: dep.id,
        kind: entry.draft.kind,
        document: entry.document,
        format: active.format as McpConfigFormat,
        activeRevisionId: dep.activeRevisionId,
        ignoredFields: entry.draft.ignoredFields ?? [],
        variables: Object.keys(env)
          .filter((key) => !Object.hasOwn(entry.publicEnv, key))
          .sort()
          .map((key) => ({
            key,
            secret: true,
            set: Array.isArray(configured) && configured.includes(key),
            required: Array.isArray(required) && required.includes(key),
          })),
        resolved: [
          ...(typeof lock.sourceRef === "string"
            ? [
                {
                  label: entry.draft.kind === "remote" ? "url" : "command",
                  value: lock.sourceRef,
                },
              ]
            : []),
          ...(Array.isArray(lock.args)
            ? [{ label: "args", value: lock.args.join(" ") }]
            : []),
        ],
        revisions: history.map((r) => ({
          id: r.id,
          revision: r.revision,
          format: r.format as McpConfigFormat,
          createdAt: r.createdAt.toISOString(),
          createdByName: (r.createdById && names.get(r.createdById)) || null,
          active: r.id === dep.activeRevisionId,
        })),
        runtime: {
          target: dep.runtimeTarget as McpRuntimeTarget,
          sandboxId: dep.runtimeSandboxId,
          sandboxes: sandboxes
            .filter((s) =>
              isExternalSandboxCandidate({ ...s, isAgentTemplate: false }),
            )
            .map(({ id, name, kind }) => ({ id, name, kind })),
          canUseArbitraryCommands: canManage,
        },
        samplingEnabled: dep.samplingEnabled,
        canManage,
      },
    };
  } catch (e) {
    return failure(e);
  }
}

export async function previewMcpConfigAction(
  input: DocumentInput,
): Promise<McpConfigPreview> {
  try {
    const ctx = await actionScope({ slug: input.workspace });
    if (!ctx) fail("notAuthorized");
    const dep = await load(ctx.ws, input.deploymentId);
    const previous = await snapshot(ctx.ws, dep);
    const { entry, missing } = await plan(ctx.ws, dep, input.document);
    return {
      ok: true,
      document: entry.document,
      ignoredFields: entry.draft.ignoredFields ?? [],
      extractedSecrets: Object.keys(entry.literals),
      missingVariables: missing,
      changes: mcpDocumentDiff(previous.document, entry.document),
      restartRequired:
        previous.document !== entry.document ||
        !!Object.keys(entry.literals).length,
    };
  } catch (e) {
    return failure(e);
  }
}

async function mutate(
  input: Target,
  change: Change,
): Promise<McpConfigSaveResult> {
  try {
    const ctx = await actionScope({
      slug: input.workspace,
      capability: "manage",
    });
    if (!ctx) fail("notAuthorized");
    const { ws } = ctx;
    const operation = await runMcpDeploymentOperation(
      ws.id,
      input.deploymentId,
      async () => {
        const dep = await load(ws, input.deploymentId);
        const active = await snapshot(ws, dep);
        let base = active;
        if (change.kind === "rollback") {
          if (typeof change.revisionId !== "string" || !change.revisionId)
            fail("notFound");
          base =
            (await db.mcpConfigRevision.findFirst({
              where: {
                deploymentId: dep.id,
                id: change.revisionId,
                deployment: { workspace: workspaceScopeWhere(ws) },
              },
            })) ?? fail("notFound");
        }
        const next = await plan(
          ws,
          dep,
          change.kind === "document" ? change.document : base.document,
          "values" in change ? change.values : {},
          change.kind === "variables" ? change.remove : [],
        );
        const target =
          change.kind === "runtime"
            ? change.target
            : (dep.runtimeTarget as McpRuntimeTarget);
        const sandboxId =
          change.kind === "runtime"
            ? (change.sandboxId ?? null)
            : dep.runtimeSandboxId;
        if (change.kind === "runtime" && dep.source === "remote")
          fail("sandboxUnavailable");
        if (
          !(
            await validateMcpRuntimeTarget({
              workspaceId: ws.id,
              target,
              sandboxId,
              source: next.source,
              command: next.source === "config" ? next.sourceRef : undefined,
            })
          ).ok
        )
          fail("sandboxUnavailable");
        if (next.entry.draft.files?.length) {
          const files = await db.deploymentConfigFile.findMany({
            where: {
              deploymentId: dep.id,
              deployment: { workspace: workspaceScopeWhere(ws) },
            },
            select: { path: true },
          });
          if (
            next.entry.draft.files.some(
              (required) =>
                !files.some(
                  (f) =>
                    f.path === required.path ||
                    f.path.startsWith(`${required.path}/`),
                ),
            )
          )
            fail("invalidConfig");
        }
        const pinned =
          change.kind === "dependencies" || change.kind === "document"
            ? await resolvePinnedMcpRecipe(next)
            : {
                sourceRef: next.sourceRef,
                installCfg: {
                  ...next.installCfg,
                  ...(Array.isArray(record(base.resolved).args) && {
                    args: record(base.resolved).args,
                  }),
                },
              };
        // The existing supervisor can persist stopped/running asynchronously. Quiesce the old credentials before activating the new configuration.
        await stopProcess(dep.id);
        const revision = await db.$transaction(async (tx) => {
          const current = await locked(ws, dep.id, tx);
          if (
            current.activeRevisionId !== dep.activeRevisionId ||
            JSON.stringify(current.installCfg) !==
              JSON.stringify(dep.installCfg)
          )
            fail("saveFailed");
          await backfill(ws, current, tx);
          const latest = await tx.mcpConfigRevision.aggregate({
            where: { deploymentId: dep.id },
            _max: { revision: true },
          });
          const row = await tx.mcpConfigRevision.create({
            data: {
              deploymentId: dep.id,
              revision: (latest._max.revision ?? 0) + 1,
              format: change.kind === "document" ? "mcp-json" : base.format,
              document: next.entry.document,
              resolved: resolvedMcpLock(pinned),
              createdById: ctx.user.id,
            },
            select: { id: true, revision: true },
          });
          if (next.revokeOAuth) {
            const filter = { deploymentId: dep.id, workspaceId: ws.id };
            await tx.mcpOAuthCredential.deleteMany({ where: filter });
            await tx.mcpOAuthPending.deleteMany({ where: filter });
          }
          await tx.deployment.update({
            where: where(ws, dep.id),
            data: {
              activeRevisionId: row.id,
              source: next.source,
              sourceRef: pinned.sourceRef,
              installCfg: pinned.installCfg as Prisma.InputJsonObject,
              status: next.status,
              runtimeTarget: target,
              runtimeSandboxId: sandboxId,
            },
          });
          return row;
        });
        let status = next.status;
        if (status === "provisioning") {
          try {
            const { spec } = await resolveMcpConnectionSpawnSpec({
              workspaceId: ws.id,
              deploymentId: dep.id,
              rebuild: true,
            });
            await restartProcess(dep.id, spec, mcpProcessOptions(ctx, dep.id));
          } catch (e) {
            if (
              e instanceof Error &&
              ["MCP_CREDENTIAL_REQUIRED", "MCP_REAUTH_REQUIRED"].includes(
                e.message,
              )
            ) {
              await killProcess(dep.id, { finalStatus: "setup_required" });
              status = "setup_required";
            } else {
              await db.deployment.updateMany({
                where: { ...where(ws, dep.id), activeRevisionId: revision.id },
                data: { status: "error" },
              });
              fail("saveFailed");
            }
          }
        }
        return {
          ok: true as const,
          revisionId: revision.id,
          revision: revision.revision,
          status,
        };
      },
    );
    revalidatePath(`/app/${ws.slug}/mcp/${input.deploymentId}`);
    revalidatePath(`/app/${ws.slug}/mcp`);
    return operation.accepted ? operation.value : fail("saveFailed");
  } catch (e) {
    return failure(e);
  }
}
export async function saveMcpConfigAction(
  input: DocumentInput & { values?: Record<string, string> },
) {
  return mutate(input, {
    kind: "document",
    document: input.document,
    values: input.values,
  });
}
export async function setMcpVariablesAction(input: Target & Variables) {
  return mutate(input, {
    kind: "variables",
    values: input.values,
    remove: input.remove,
  });
}
export async function rollbackMcpConfigAction(
  input: Target & { revisionId: string },
) {
  return mutate(input, { kind: "rollback", revisionId: input.revisionId });
}
export async function updateMcpDependenciesAction(input: Target) {
  return mutate(input, { kind: "dependencies" });
}
export async function setMcpRuntimeTargetAction(
  input: Target & { target: McpRuntimeTarget; sandboxId?: string | null },
) {
  return mutate(input, {
    kind: "runtime",
    target: input.target,
    sandboxId: input.sandboxId,
  });
}
export async function setMcpSamplingAction(
  input: Target & { enabled: boolean },
): Promise<{ ok: true } | McpConfigFailure> {
  try {
    const ctx = await actionScope({
      slug: input.workspace,
      capability: "manage",
    });
    if (!ctx) fail("notAuthorized");
    if (typeof input.enabled !== "boolean") fail("invalidConfig");
    const result = await runMcpDeploymentOperation(
      ctx.ws.id,
      input.deploymentId,
      () =>
        db.deployment.updateMany({
          where: where(ctx.ws, input.deploymentId),
          data: { samplingEnabled: input.enabled },
        }),
    );
    if (!result.accepted) fail("saveFailed");
    if (!result.value.count) fail("notFound");
    revalidatePath(`/app/${ctx.ws.slug}/mcp/${input.deploymentId}`);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}
