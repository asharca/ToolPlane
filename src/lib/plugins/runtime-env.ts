import "server-only";
import { createHash } from "node:crypto";
import { addresses } from "@/lib/a2a/remote-network";
import { resolvePrivateHostsSettings } from "@/lib/admin/settings";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { requireAgentRevision } from "@/lib/agents/revisions";
import {
  createAgentPluginProxyToken,
  runtimePluginProxyBase,
  verifyAgentRuntimeToken,
} from "@/lib/agents/runtime-access";
import {
  parsePiPackageReleaseManifest,
  type PiPackageManifestV1,
} from "@/lib/pi-packages/manifest";
import { parseRemoteMcpPrivateHosts } from "../../../scripts/remote-mcp-private-hosts.mjs";
import {
  evaluatePluginEnvStatus,
  isEnvRequired,
  isEnvSecret,
  supportsPlatformPreset,
  validatePluginEnvUrl,
} from "./env-schema";
import {
  decryptMarketInstallCustomEnvValues,
  decryptOfficialPluginPresetValues,
  isOfficialRegistrySource,
  resolveLivePluginEnvSourceMode,
} from "./env-store";

export type PreparedTurnPluginEnv = {
  env: Record<string, string>;
  unsetKeys: string[];
  hostRedactTokens: string[];
  sandboxRedactTokens: string[];
  signature: string;
};

export async function prepareTurnPluginEnv(input: {
  workspaceId: string;
  agentId: string;
  agentRevisionId?: string;
  sandboxId: string;
  conversationId?: string;
  a2aContextId?: string;
  runtimeAccessToken: string;
  packages: ReadonlyArray<{
    marketInstallId: string;
    releaseId: string;
    manifest: PiPackageManifestV1;
  }>;
}): Promise<PreparedTurnPluginEnv> {
  const envPackages = input.packages
    .filter((pkg) => (pkg.manifest.package.toolplane?.env?.length ?? 0) > 0)
    .sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId));

  if (!envPackages.length) {
    return {
      env: {},
      unsetKeys: [],
      hostRedactTokens: [],
      sandboxRedactTokens: [],
      signature: "",
    };
  }

  if (!input.agentRevisionId) {
    throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
  }

  const runtimeToken = await verifyAgentRuntimeToken(input.runtimeAccessToken);
  if (
    !runtimeToken ||
    runtimeToken.workspaceId !== input.workspaceId ||
    runtimeToken.agentId !== input.agentId ||
    runtimeToken.agentRevisionId !== input.agentRevisionId ||
    runtimeToken.sandboxId !== input.sandboxId
  ) {
    throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
  }

  const revision = await requireAgentRevision(
    db,
    input.agentId,
    input.agentRevisionId,
  );
  const reservedNames = new Set(
    revision.config.environment.credentialReferences.map((ref) => ref.name),
  );
  const seenPluginEnvNames = new Set<string>();
  for (const pkg of envPackages) {
    for (const item of pkg.manifest.package.toolplane?.env ?? []) {
      if (reservedNames.has(item.name) || seenPluginEnvNames.has(item.name)) {
        throw new Error("PI_PACKAGE_ENV_CONFLICT");
      }
      seenPluginEnvNames.add(item.name);
    }
  }

  const installs = await db.marketInstall.findMany({
    where: {
      id: { in: envPackages.map((pkg) => pkg.marketInstallId) },
      targetWorkspaceId: input.workspaceId,
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
  const byInstallId = new Map(installs.map((row) => [row.id, row]));

  const env: Record<string, string> = {};
  const unsetKeys: string[] = [];
  const hostRedactTokens: string[] = [];
  const sandboxRedactTokens: string[] = [];
  const signatureEntries: Array<{
    marketInstallId: string;
    releaseId: string;
    envMode: "platform_preset" | "custom";
    proxiedBaseUrls: Record<string, string>;
    nonProxyEnvDigest: string;
    unsetKeys: string[];
  }> = [];

  for (const pkg of envPackages) {
    const install = byInstallId.get(pkg.marketInstallId);
    if (!install) throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
    const requirements = pkg.manifest.package.toolplane?.env ?? [];
    const httpProxies = pkg.manifest.package.toolplane?.httpProxies ?? [];
    const isOfficial = isOfficialRegistrySource(
      install.listing.githubRegistryResource?.registry,
    );
    const presetConfiguredKeys =
      install.listing.officialEnvPreset?.configuredKeys ?? [];
    const status = evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial,
      presetConfiguredKeys,
      installedMode: install.envConfig?.mode ?? null,
      customConfiguredKeys: install.envConfig?.configuredKeys,
    });
    const liveMode = status.mode ?? status.effectiveDefaultMode;
    if (!status.complete || !liveMode) {
      throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
    }

    let decrypted: Record<string, string>;
    if (liveMode === "platform_preset") {
      if (
        !isOfficial ||
        !supportsPlatformPreset({ env: requirements, httpProxies })
      ) {
        throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      }
      const preset = await db.officialPluginEnvPreset.findUnique({
        where: { listingId: install.listingId },
        select: { encryptedValues: true },
      });
      if (!preset) throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      decrypted = decryptOfficialPluginPresetValues(
        install.listingId,
        preset.encryptedValues,
      );
    } else {
      if (!install.envConfig?.encryptedValues) {
        throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      }
      decrypted = decryptMarketInstallCustomEnvValues(
        input.workspaceId,
        install.id,
        install.listingId,
        install.envConfig.encryptedValues,
      );
    }

    for (const item of requirements) {
      if (isEnvRequired(item)) {
        const value = decrypted[item.name];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
        }
      }
    }

    const proxiedBaseUrls: Record<string, string> = {};
    const proxiedEnvKeys = new Set<string>();
    for (const proxy of httpProxies) {
      proxiedEnvKeys.add(proxy.baseUrlEnv);
      proxiedEnvKeys.add(proxy.auth.secretEnv);

      const rawBaseUrl =
        decrypted[proxy.baseUrlEnv]?.trim() || proxy.defaultUpstreamUrl;
      if (!rawBaseUrl) throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      try {
        validatePluginEnvUrl(rawBaseUrl);
      } catch {
        throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      }

      const secret = decrypted[proxy.auth.secretEnv];
      if (
        typeof secret !== "string" ||
        !secret.trim() ||
        /[\r\n\0]/.test(secret)
      ) {
        throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      }

      const proxyUrl = runtimePluginProxyBase(pkg.marketInstallId, proxy.key);
      const proxyJwt = await createAgentPluginProxyToken({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentRevisionId: input.agentRevisionId,
        sandboxId: input.sandboxId,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.a2aContextId ? { a2aContextId: input.a2aContextId } : {}),
        ...(runtimeToken.a2aTaskId
          ? {
              a2aTaskId: runtimeToken.a2aTaskId,
              a2aLeaseToken: runtimeToken.a2aLeaseToken,
            }
          : {}),
        marketInstallId: pkg.marketInstallId,
        releaseId: pkg.releaseId,
        proxyKey: proxy.key,
        envMode: liveMode,
        exp: runtimeToken.exp,
        ...(runtimeToken.traceId ? { traceId: runtimeToken.traceId } : {}),
        ...(runtimeToken.parentSpanId
          ? { parentSpanId: runtimeToken.parentSpanId }
          : {}),
      });

      env[proxy.baseUrlEnv] = proxyUrl;
      env[proxy.auth.secretEnv] = proxyJwt;
      proxiedBaseUrls[proxy.key] = proxyUrl;
      // Host redacts both the short-lived proxy JWT and the real upstream secret;
      // the sandbox only sees `proxyJwt`, never the real proxied secret.
      hostRedactTokens.push(proxyJwt, secret);
      sandboxRedactTokens.push(proxyJwt);
    }

    const nonProxyEntries: Array<[string, string]> = [];
    const pkgUnsetKeys: string[] = [];
    for (const item of requirements) {
      if (proxiedEnvKeys.has(item.name)) continue;
      // Platform presets never expose real secrets outside HTTP proxies.
      if (liveMode === "platform_preset" && isEnvSecret(item)) {
        throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
      }
      const value = decrypted[item.name];
      if (typeof value === "string" && value.trim()) {
        env[item.name] = value;
        nonProxyEntries.push([item.name, value]);
        if (isEnvSecret(item)) {
          hostRedactTokens.push(value);
          if (liveMode === "custom") sandboxRedactTokens.push(value);
        }
      } else {
        unsetKeys.push(item.name);
        pkgUnsetKeys.push(item.name);
      }
    }

    nonProxyEntries.sort(([a], [b]) => a.localeCompare(b));
    pkgUnsetKeys.sort();
    signatureEntries.push({
      marketInstallId: pkg.marketInstallId,
      releaseId: pkg.releaseId,
      envMode: liveMode,
      proxiedBaseUrls,
      nonProxyEnvDigest: createHash("sha256")
        .update(JSON.stringify(nonProxyEntries))
        .digest("hex"),
      unsetKeys: pkgUnsetKeys,
    });
  }

  const dedupedUnset = [...new Set(unsetKeys)].sort();
  const dedupedHostRedact = [...new Set(hostRedactTokens.filter(Boolean))];
  const dedupedSandboxRedact = [
    ...new Set(sandboxRedactTokens.filter(Boolean)),
  ];
  const signature = createHash("sha256")
    .update(JSON.stringify(signatureEntries))
    .digest("hex");

  return {
    env,
    unsetKeys: dedupedUnset,
    hostRedactTokens: dedupedHostRedact,
    sandboxRedactTokens: dedupedSandboxRedact,
    signature,
  };
}

export async function collectSessionPluginSecretsForRedaction(
  workspaceId: string,
  agentId: string,
): Promise<string[]> {
  const [bindings, revisions] = await Promise.all([
    db.agentPiPackage.findMany({
      where: { agentId, agent: { workspaceId } },
      select: {
        marketInstallId: true,
        releaseId: true,
        targetReleaseId: true,
      },
    }),
    db.agentRevision.findMany({
      where: { agentId, agent: { workspaceId } },
      orderBy: { version: "desc" },
      take: 25,
      select: { config: true },
    }),
  ]);

  const installIds = new Set<string>();
  const releaseIds = new Set<string>();
  for (const row of bindings) {
    installIds.add(row.marketInstallId);
    releaseIds.add(row.releaseId);
    if (row.targetReleaseId) releaseIds.add(row.targetReleaseId);
  }
  for (const row of revisions) {
    const parsed = AgentRevisionConfigSchema.safeParse(row.config);
    if (!parsed.success) continue;
    for (const pkg of parsed.data.packages) {
      installIds.add(pkg.marketInstallId);
      releaseIds.add(pkg.releaseId);
    }
  }
  if (!installIds.size) return [];

  const [installs, releases] = await Promise.all([
    db.marketInstall.findMany({
      where: {
        id: { in: [...installIds] },
        targetWorkspaceId: workspaceId,
      },
      select: {
        id: true,
        listingId: true,
        currentRelease: { select: { manifest: true, checksum: true } },
        envConfig: { select: { encryptedValues: true } },
        listing: {
          select: {
            githubRegistryResource: {
              select: {
                registry: { select: { official: true, workspaceId: true } },
              },
            },
            officialEnvPreset: { select: { encryptedValues: true } },
          },
        },
      },
    }),
    releaseIds.size
      ? db.marketRelease.findMany({
          where: { id: { in: [...releaseIds] } },
          select: { listingId: true, manifest: true, checksum: true },
        })
      : Promise.resolve([]),
  ]);

  const secretKeysByListing = new Map<string, Set<string>>();
  const recordSecretKeys = (
    listingId: string,
    manifest: unknown,
    checksum: string,
  ) => {
    const requirements =
      parsePiPackageReleaseManifest(manifest, checksum).package.toolplane
        ?.env ?? [];
    if (!requirements.length) return;
    let keys = secretKeysByListing.get(listingId);
    if (!keys) {
      keys = new Set();
      secretKeysByListing.set(listingId, keys);
    }
    for (const item of requirements) {
      if (isEnvSecret(item)) keys.add(item.name);
    }
  };

  for (const rel of releases) {
    recordSecretKeys(rel.listingId, rel.manifest, rel.checksum);
  }
  for (const install of installs) {
    recordSecretKeys(
      install.listingId,
      install.currentRelease.manifest,
      install.currentRelease.checksum,
    );
  }

  const secrets = new Set<string>();
  for (const install of installs) {
    const secretKeys = secretKeysByListing.get(install.listingId);
    if (!secretKeys?.size) continue;
    if (install.envConfig?.encryptedValues) {
      const customValues = decryptMarketInstallCustomEnvValues(
        workspaceId,
        install.id,
        install.listingId,
        install.envConfig.encryptedValues,
      );
      for (const [key, value] of Object.entries(customValues)) {
        if (secretKeys.has(key) && value.trim()) secrets.add(value);
      }
    }
    if (
      isOfficialRegistrySource(
        install.listing.githubRegistryResource?.registry,
      ) &&
      install.listing.officialEnvPreset?.encryptedValues
    ) {
      const presetValues = decryptOfficialPluginPresetValues(
        install.listingId,
        install.listing.officialEnvPreset.encryptedValues,
      );
      for (const [key, value] of Object.entries(presetValues)) {
        if (secretKeys.has(key) && value.trim()) secrets.add(value);
      }
    }
  }
  return [...secrets];
}

export async function collectSessionCustomNonProxyPluginSecrets(input: {
  workspaceId: string;
  agentId: string;
  agentRevisionId: string;
}): Promise<Record<string, string>> {
  const revision = await requireAgentRevision(
    db,
    input.agentId,
    input.agentRevisionId,
  );
  const packages = revision.config.packages;
  if (!packages.length) return {};

  const installIds = packages.map((pkg) => pkg.marketInstallId);
  const releaseIds = [...new Set(packages.map((pkg) => pkg.releaseId))];
  const [installs, releases] = await Promise.all([
    db.marketInstall.findMany({
      where: {
        id: { in: installIds },
        targetWorkspaceId: input.workspaceId,
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
            githubRegistryResource: {
              select: {
                registry: { select: { official: true, workspaceId: true } },
              },
            },
            officialEnvPreset: { select: { configuredKeys: true } },
          },
        },
      },
    }),
    db.marketRelease.findMany({
      where: { id: { in: releaseIds } },
      select: { id: true, listingId: true, manifest: true, checksum: true },
    }),
  ]);
  const installById = new Map(installs.map((row) => [row.id, row]));
  const releaseById = new Map(releases.map((row) => [row.id, row]));

  const result: Record<string, string> = {};
  for (const pkg of packages) {
    const install = installById.get(pkg.marketInstallId);
    const release = releaseById.get(pkg.releaseId);
    if (!install || !release || release.listingId !== install.listingId) {
      continue;
    }
    const parsed = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    const requirements = parsed.package.toolplane?.env ?? [];
    if (!requirements.length) continue;
    const httpProxies = parsed.package.toolplane?.httpProxies ?? [];
    const liveMode = resolveLivePluginEnvSourceMode({
      requirements,
      httpProxies,
      isOfficial: isOfficialRegistrySource(
        install.listing.githubRegistryResource?.registry,
      ),
      presetConfiguredKeys: install.listing.officialEnvPreset?.configuredKeys,
      envConfig: install.envConfig,
    });
    // NEVER obfuscate/restore platform preset secrets or proxied secrets in model responses.
    if (liveMode !== "custom" || !install.envConfig?.encryptedValues) {
      continue;
    }
    const proxiedSecretNames = new Set(
      httpProxies.map((proxy) => proxy.auth.secretEnv),
    );
    const decrypted = decryptMarketInstallCustomEnvValues(
      input.workspaceId,
      install.id,
      install.listingId,
      install.envConfig.encryptedValues,
    );
    for (const item of requirements) {
      if (isEnvSecret(item) && !proxiedSecretNames.has(item.name)) {
        const value = decrypted[item.name];
        if (typeof value === "string" && value.trim()) {
          result[item.name] = value;
        }
      }
    }
  }
  return result;
}

export async function resolveCustomPluginUpstreamAddress(
  host: string,
  signal: AbortSignal,
) {
  const settings = await resolvePrivateHostsSettings();
  const privateHosts = parseRemoteMcpPrivateHosts(settings.value);
  return addresses(host, signal, privateHosts);
}
