import "server-only";
import type { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import type {
  AgentPluginProxyTokenPayload,
  AgentRuntimeTokenPayload,
} from "./runtime-access";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";
import { requireAgentRevision } from "./revisions";
import {
  assertLocalRuntimeToken,
  assertLocalTaskLease,
} from "@/lib/a2a/local-runtime";
import { assertAgentEnvironmentCredentialReferences } from "./environment-credentials";
import {
  resolveAgentModelOverride,
  conversationModelOverride,
} from "./turn-model";
import type { SandboxMcpTool } from "@/lib/sandboxes/mcp-policy";
import {
  externalSandboxTools,
  isExternalSandboxAccess,
  narrowExternalSandboxAccess,
} from "@/lib/sandboxes/external";
import { AgentRevisionConfigSchema } from "./revision-types";
import { enrichLogContext } from "@/lib/observability/context";
import { entryConversationIds } from "./entry-kinds";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { assertMarketReleasesExecutable } from "@/lib/pi-packages/revocation";
import {
  evaluatePluginEnvStatus,
  isEnvRequired,
  isEnvSecret,
  supportsPlatformPreset,
  validatePluginEnvUrl,
  type PiPackageHttpProxy,
} from "@/lib/plugins/env-schema";
import {
  decryptMarketInstallCustomEnvValues,
  decryptOfficialPluginPresetValues,
  isOfficialRegistrySource,
} from "@/lib/plugins/env-store";
import { PluginError } from "@/lib/plugins/errors";

async function verifyActiveRuntimeSession(
  tx: Prisma.TransactionClient,
  token: Pick<
    AgentRuntimeTokenPayload | AgentPluginProxyTokenPayload,
    | "workspaceId"
    | "agentId"
    | "agentRevisionId"
    | "sandboxId"
    | "conversationId"
    | "a2aContextId"
  >,
) {
  const revision = await requireAgentRevision(
    tx,
    token.agentId,
    token.agentRevisionId,
  );
  if (revision.config.runtimeKind !== "pi-sdk") return null;
  const agent = await tx.agent.findFirst({
    where: {
      id: token.agentId,
      workspaceId: token.workspaceId,
      runtimeKind: revision.config.runtimeKind,
      retiredAt: null,
      workspace: { status: "active" },
    },
    select: {
      servers: { select: { deploymentId: true, allowedToolNames: true } },
      externalSandboxes: {
        where: { sandbox: { workspaceId: token.workspaceId } },
        select: { sandboxId: true, access: true },
      },
    },
  });
  if (!agent) return null;
  if (token.conversationId) {
    const conversation = await tx.conversation.findFirst({
      where: {
        id: token.conversationId,
        agentId: token.agentId,
        agentRevisionId: token.agentRevisionId,
        legacyRevisionUnresolved: false,
        sandboxId: token.sandboxId,
      },
      select: { id: true },
    });
    if (!conversation) return null;
  }
  let contextConversationId: string | undefined;
  if (token.a2aContextId) {
    const context = await tx.a2AContext.findFirst({
      where: {
        id: token.a2aContextId,
        workspaceId: token.workspaceId,
        agentId: token.agentId,
        targetKind: "local",
        agentRevisionId: token.agentRevisionId,
        legacyRevisionUnresolved: false,
        sandboxId: token.sandboxId,
      },
      select: {
        id: true,
        entryBindings: { select: { kind: true, sourceId: true } },
      },
    });
    if (!context) return null;
    const conversations = await entryConversationIds(
      tx,
      token,
      context.entryBindings,
    );
    if (conversations.size > 1) return null;
    contextConversationId = [...conversations][0];
    if (token.conversationId && contextConversationId !== token.conversationId)
      return null;
    if (
      contextConversationId &&
      !token.conversationId &&
      !(await tx.conversation.findFirst({
        where: {
          id: contextConversationId,
          agentId: token.agentId,
          agentRevisionId: token.agentRevisionId,
          legacyRevisionUnresolved: false,
          sandboxId: token.sandboxId,
        },
        select: { id: true },
      }))
    )
      return null;
  }
  const sandbox = await tx.sandbox.findFirst({
    where: {
      id: token.sandboxId,
      workspaceId: token.workspaceId,
      kind: "docker",
    },
    select: { config: true },
  });
  if (!sandbox) return null;
  const config =
    sandbox.config &&
    typeof sandbox.config === "object" &&
    !Array.isArray(sandbox.config)
      ? sandbox.config
      : {};
  if (config.readOnly === true) return null;
  const conversationId = token.conversationId ?? contextConversationId;
  if (
    conversationId &&
    Array.isArray(config.pendingWorkspaceDeletes) &&
    config.pendingWorkspaceDeletes.includes(conversationId)
  )
    return null;
  if (config.scope === "agent") {
    if (
      config.managedBy !== "agent-conversation" ||
      config.agentId !== token.agentId ||
      typeof config.agentRevisionId !== "string"
    )
      return null;
    const pinned = await tx.agentRevision.findFirst({
      where: { id: config.agentRevisionId, agentId: token.agentId },
      select: { config: true },
    });
    if (!pinned) return null;
    const environmentOwner = AgentRevisionConfigSchema.parse(pinned.config);
    if (
      environmentOwner.runtimeKind !== revision.config.runtimeKind ||
      !isDeepStrictEqual(
        environmentOwner.environment,
        revision.config.environment,
      )
    )
      return null;
  }
  return { revision, agent, conversationId };
}

/** A token identifies a pinned session; it never freezes live authorization. */
export async function resolveAgentRuntimeGrant(
  token: AgentRuntimeTokenPayload,
  modelTarget?: { providerId: string; model: string },
): Promise<{
  mcpToolPolicy: PiPackageMcpToolPolicy;
  runtimeKind: "pi-sdk";
  model: string | null;
  secretObfuscation: boolean;
  advisor?: { providerId: string; model: string };
  /** Attached sandbox ID → tools allowed by both the pinned revision and the live attachment. */
  externalSandboxTools: Record<string, SandboxMcpTool[]>;
} | null> {
  try {
    if (
      !token.agentRevisionId ||
      (!token.conversationId && !token.a2aContextId)
    )
      return null;
    if (token.a2aTaskId) await assertLocalRuntimeToken(token);
    let verifiedConversationId: string | undefined;
    const grant = await db.$transaction(async (tx) => {
      const session = await verifyActiveRuntimeSession(tx, token);
      if (!session) return null;
      const { revision, agent, conversationId } = session;
      const provider = revision.config.providerId
        ? await tx.modelProvider.findFirst({
            where: {
              id: token.modelOverride?.providerId ?? revision.config.providerId,
              workspaceId: token.workspaceId,
            },
            select: { apiKey: true },
          })
        : null;
      if (!provider?.apiKey.trim()) return null;
      if (token.modelOverride) {
        if (token.modelOverride.providerId !== token.providerId) return null;
        await resolveAgentModelOverride(
          token.workspaceId,
          token.modelOverride,
          revision.config.runtimeKind,
          tx,
        );
      } else if (revision.config.providerId !== token.providerId) return null;
      await assertAgentEnvironmentCredentialReferences(
        tx,
        token.workspaceId,
        token.agentId,
        revision.config.environment.credentialReferences,
      );
      if (modelTarget) {
        const primary = token.modelOverride ?? {
          providerId: token.providerId,
          model: revision.config.model,
        };
        const targets = [
          ...(revision.config.fallbackModels ?? []),
          ...Object.values(revision.config.roleModels ?? {}).filter(
            (target) => target !== undefined,
          ),
        ];
        const isPrimary =
          modelTarget.providerId === primary.providerId &&
          modelTarget.model === primary.model;
        const isAdvisor =
          modelTarget.providerId === revision.config.advisor?.providerId &&
          modelTarget.model === revision.config.advisor?.model;
        const isSelected =
          revision.config.modelProviderIds.includes(modelTarget.providerId) &&
          targets.some(
            (target) =>
              target.providerId === modelTarget.providerId &&
              target.model === modelTarget.model,
          );
        if (!isPrimary && !isSelected && !isAdvisor) return null;
        if (!isPrimary)
          await resolveAgentModelOverride(
            token.workspaceId,
            modelTarget,
            revision.config.runtimeKind,
            tx,
          );
      }
      if (conversationId && token.modelOverride) {
        const session = await tx.conversation.findFirst({
          where: {
            id: conversationId,
            agentId: token.agentId,
            agent: { workspaceId: token.workspaceId },
          },
          select: { modelOverride: true, runtimeSessionKey: true },
        });
        if (session?.runtimeSessionKey?.startsWith("channel:")) {
          const current = conversationModelOverride(session.modelOverride);
          if (
            !current ||
            current.providerId !== token.modelOverride.providerId ||
            current.model !== token.modelOverride.model
          )
            return null;
        }
      }
      const currentDeployments = new Map<string, string[]>(
        agent.servers.map((server) => [
          server.deploymentId,
          server.allowedToolNames,
        ]),
      );
      const mcpToolPolicy: PiPackageMcpToolPolicy = {};
      for (const grant of revision.config.mcpGrants) {
        const liveTools = currentDeployments.get(grant.deploymentId);
        if (liveTools) {
          mcpToolPolicy[grant.deploymentId] = grant.allowedToolNames.filter(
            (name) => liveTools.includes(name),
          );
        }
      }
      if (token.deploymentIds.some((id) => !Object.hasOwn(mcpToolPolicy, id)))
        return null;
      // A detached sandbox loses only its own tools, never the whole session grant.
      const externalTools: Record<string, SandboxMcpTool[]> = {};
      for (const pinned of revision.config.externalSandboxes) {
        const live = agent.externalSandboxes.find(
          (entry) => entry.sandboxId === pinned.sandboxId,
        );
        if (live && isExternalSandboxAccess(live.access))
          externalTools[pinned.sandboxId] = externalSandboxTools(
            narrowExternalSandboxAccess(pinned.access, live.access),
          );
      }
      verifiedConversationId = conversationId;
      return {
        mcpToolPolicy,
        externalSandboxTools: externalTools,
        runtimeKind: revision.config.runtimeKind,
        secretObfuscation: revision.config.secretObfuscation === true,
        ...(revision.config.advisor
          ? {
              advisor: {
                providerId: revision.config.advisor.providerId,
                model: revision.config.advisor.model,
              },
            }
          : {}),
        model:
          modelTarget?.model ??
          token.modelOverride?.model ??
          revision.config.model,
      };
    });
    if (grant)
      enrichLogContext({
        ...(token.a2aTaskId ? { taskId: token.a2aTaskId } : {}),
        ...(verifiedConversationId
          ? { conversationId: verifiedConversationId }
          : {}),
      });
    return grant;
  } catch {
    return null;
  }
}

export async function isAgentRuntimeGrantCurrent(
  token: AgentRuntimeTokenPayload,
): Promise<boolean> {
  return (await resolveAgentRuntimeGrant(token)) !== null;
}

export type AgentPluginProxyGrantResult =
  | {
      ok: true;
      envMode: "platform_preset" | "custom";
      upstreamBaseUrl: string;
      auth: PiPackageHttpProxy["auth"];
      secret: string;
      secretValues: string[];
      allowPrivateAdminHost: boolean;
      conversationId?: string;
    }
  | {
      ok: false;
      status: 403 | 409;
      code:
        | "PLUGIN_PROXY_FORBIDDEN"
        | "PLUGIN_PROXY_REVOKED"
        | "PLUGIN_ENV_MODE_CHANGED"
        | "PLUGIN_ENV_INCOMPLETE";
    };

export async function resolveAgentPluginProxyGrant(
  token: AgentPluginProxyTokenPayload,
): Promise<AgentPluginProxyGrantResult> {
  try {
    if (
      !token.agentRevisionId ||
      (!token.conversationId && !token.a2aContextId)
    ) {
      return { ok: false, status: 403, code: "PLUGIN_PROXY_FORBIDDEN" };
    }
    if (token.a2aTaskId) {
      try {
        await assertLocalTaskLease(token);
      } catch {
        return { ok: false, status: 403, code: "PLUGIN_PROXY_FORBIDDEN" };
      }
    }

    let verifiedConversationId: string | undefined;
    const result = await db.$transaction(async (tx) => {
      const session = await verifyActiveRuntimeSession(tx, token);
      if (!session) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_PROXY_FORBIDDEN",
        } as const;
      }
      if (
        !session.revision.config.packages.some(
          (pkg) =>
            pkg.marketInstallId === token.marketInstallId &&
            pkg.releaseId === token.releaseId,
        )
      ) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_PROXY_FORBIDDEN",
        } as const;
      }

      try {
        await assertMarketReleasesExecutable(tx, [token.releaseId]);
      } catch (err) {
        if (err instanceof PluginError) {
          return {
            ok: false,
            status: 403,
            code: "PLUGIN_PROXY_REVOKED",
          } as const;
        }
        throw err;
      }

      const install = await tx.marketInstall.findFirst({
        where: {
          id: token.marketInstallId,
          targetWorkspaceId: token.workspaceId,
          status: { in: ["ready", "uninstalled"] },
        },
        select: {
          id: true,
          listingId: true,
          envConfig: {
            select: { mode: true, configuredKeys: true, encryptedValues: true },
          },
          listing: {
            select: {
              id: true,
              githubRegistryResource: {
                select: {
                  registry: { select: { official: true, workspaceId: true } },
                },
              },
              officialEnvPreset: { select: { configuredKeys: true } },
            },
          },
        },
      });
      if (!install) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_PROXY_FORBIDDEN",
        } as const;
      }

      const release = await tx.marketRelease.findFirst({
        where: { id: token.releaseId, listingId: install.listingId },
        select: { manifest: true, checksum: true },
      });
      if (!release) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_PROXY_FORBIDDEN",
        } as const;
      }

      const parsed = parsePiPackageReleaseManifest(
        release.manifest,
        release.checksum,
      );
      const requirements = parsed.package.toolplane?.env ?? [];
      const httpProxies = parsed.package.toolplane?.httpProxies ?? [];
      const proxy = httpProxies.find((item) => item.key === token.proxyKey);
      if (!proxy) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_PROXY_FORBIDDEN",
        } as const;
      }

      const isOfficial = isOfficialRegistrySource(
        install.listing.githubRegistryResource?.registry,
      );
      const presetConfiguredKeys =
        install.listing.officialEnvPreset?.configuredKeys ?? [];
      const envStatus = evaluatePluginEnvStatus({
        requirements,
        httpProxies,
        isOfficial,
        presetConfiguredKeys,
        installedMode: install.envConfig?.mode ?? null,
        customConfiguredKeys: install.envConfig?.configuredKeys,
      });
      const liveMode = envStatus.mode ?? envStatus.effectiveDefaultMode;
      if (!liveMode || liveMode !== token.envMode) {
        return {
          ok: false,
          status: 403,
          code: "PLUGIN_ENV_MODE_CHANGED",
        } as const;
      }
      if (!envStatus.complete) {
        return {
          ok: false,
          status: 409,
          code: "PLUGIN_ENV_INCOMPLETE",
        } as const;
      }

      let decrypted: Record<string, string>;
      if (liveMode === "platform_preset") {
        if (
          !isOfficial ||
          !supportsPlatformPreset({ env: requirements, httpProxies })
        ) {
          return {
            ok: false,
            status: 403,
            code: "PLUGIN_PROXY_FORBIDDEN",
          } as const;
        }
        const preset = await tx.officialPluginEnvPreset.findUnique({
          where: { listingId: install.listingId },
          select: { encryptedValues: true },
        });
        if (!preset) {
          return {
            ok: false,
            status: 409,
            code: "PLUGIN_ENV_INCOMPLETE",
          } as const;
        }
        decrypted = decryptOfficialPluginPresetValues(
          install.listingId,
          preset.encryptedValues,
        );
      } else {
        if (!install.envConfig?.encryptedValues) {
          return {
            ok: false,
            status: 409,
            code: "PLUGIN_ENV_INCOMPLETE",
          } as const;
        }
        decrypted = decryptMarketInstallCustomEnvValues(
          token.workspaceId,
          install.id,
          install.listingId,
          install.envConfig.encryptedValues,
        );
      }

      for (const item of requirements) {
        if (isEnvRequired(item)) {
          const value = decrypted[item.name];
          if (typeof value !== "string" || !value.trim()) {
            return {
              ok: false,
              status: 409,
              code: "PLUGIN_ENV_INCOMPLETE",
            } as const;
          }
        }
      }

      const rawBaseUrl =
        decrypted[proxy.baseUrlEnv]?.trim() || proxy.defaultUpstreamUrl;
      if (!rawBaseUrl) {
        return {
          ok: false,
          status: 409,
          code: "PLUGIN_ENV_INCOMPLETE",
        } as const;
      }
      let upstreamBaseUrl: string;
      try {
        upstreamBaseUrl = validatePluginEnvUrl(rawBaseUrl);
      } catch {
        return {
          ok: false,
          status: 409,
          code: "PLUGIN_ENV_INCOMPLETE",
        } as const;
      }

      const secret = decrypted[proxy.auth.secretEnv];
      if (
        typeof secret !== "string" ||
        !secret.trim() ||
        /[\r\n\0]/.test(secret)
      ) {
        return {
          ok: false,
          status: 409,
          code: "PLUGIN_ENV_INCOMPLETE",
        } as const;
      }

      const secretValues = requirements
        .filter(isEnvSecret)
        .map((item) => decrypted[item.name])
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        );

      verifiedConversationId = session.conversationId;
      return {
        ok: true,
        envMode: liveMode,
        upstreamBaseUrl,
        auth: proxy.auth,
        secret,
        secretValues,
        allowPrivateAdminHost: liveMode === "platform_preset",
        conversationId: session.conversationId,
      } as const;
    });

    if (result.ok) {
      enrichLogContext({
        workspaceId: token.workspaceId,
        agentId: token.agentId,
        ...(token.a2aTaskId ? { taskId: token.a2aTaskId } : {}),
        ...(verifiedConversationId
          ? { conversationId: verifiedConversationId }
          : {}),
        ...(token.traceId
          ? { traceId: token.traceId, parentSpanId: token.parentSpanId }
          : {}),
        suppressPayload: true,
        secrets: result.secretValues,
      });
    }
    return result;
  } catch (err) {
    if (err instanceof PluginError && err.code === "listing_unavailable") {
      return { ok: false, status: 403, code: "PLUGIN_PROXY_REVOKED" };
    }
    return { ok: false, status: 403, code: "PLUGIN_PROXY_FORBIDDEN" };
  }
}
