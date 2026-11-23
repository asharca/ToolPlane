import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import {
  type WorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import { PluginError } from "./errors";
import {
  envValueKind,
  evaluatePluginEnvStatus,
  isEnvSecret,
  isValidPluginEnvName,
  normalizePluginEnvSourceMode,
  supportsPlatformPreset,
  validatePluginEnvUrl,
  type PiPackageEnvRequirement,
  type PiPackageHttpProxy,
  type PluginEnvSourceMode,
  type PluginEnvStatus,
} from "./env-schema";

export const pluginEnvUpdateSchema = z
  .object({
    mode: z.enum(["platform_preset", "custom"]),
    values: z.record(z.string(), z.string()).optional(),
    clearKeys: z.array(z.string()).max(32).optional(),
  })
  .strict();

export const pluginAddEnvConfigSchema = z
  .object({
    mode: z.enum(["platform_preset", "custom"]).optional(),
    values: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const adminPluginPresetUpdateSchema = z
  .object({
    values: z.record(z.string(), z.string()).optional(),
    clearKeys: z.array(z.string()).max(32).optional(),
  })
  .strict();

export type PluginEnvUpdateInput = z.infer<typeof pluginEnvUpdateSchema>;
export type PluginAddEnvConfigInput = z.infer<typeof pluginAddEnvConfigSchema>;
export type AdminPluginPresetUpdateInput = z.infer<
  typeof adminPluginPresetUpdateSchema
>;

export function isOfficialRegistrySource(
  registry:
    | { official: boolean; workspaceId: string | null }
    | null
    | undefined,
): boolean {
  return Boolean(registry?.official === true && registry.workspaceId === null);
}

function assertValidValuesMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginError("env_value_invalid", "Invalid plugin environment.");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !isValidPluginEnvName(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > 65_536
    ) {
      throw new PluginError("env_value_invalid", "Invalid plugin environment.");
    }
    values[key] = value;
  }
  return values;
}

export function decryptOfficialPluginPresetValues(
  listingId: string,
  encryptedValues: unknown,
): Record<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(decryptSecretText(encryptedValues));
  } catch {
    throw new PluginError(
      "env_preset_invalid",
      "Plugin preset credentials could not be decrypted.",
      500,
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).listingId !== listingId
  ) {
    throw new PluginError(
      "env_preset_invalid",
      "Plugin preset credential scope mismatch.",
      500,
    );
  }
  return assertValidValuesMap((payload as Record<string, unknown>).values);
}

function encryptOfficialPluginPresetValues(
  listingId: string,
  values: Record<string, string>,
): Prisma.InputJsonValue {
  return encryptSecretText(
    JSON.stringify({ listingId, values }),
  ) as Prisma.InputJsonValue;
}

export function decryptMarketInstallCustomEnvValues(
  workspaceId: string,
  installId: string,
  listingId: string,
  encryptedValues: unknown,
): Record<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(decryptSecretText(encryptedValues));
  } catch {
    throw new PluginError(
      "env_config_invalid",
      "Plugin environment credentials could not be decrypted.",
      500,
    );
  }
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (
    !record ||
    record.workspaceId !== workspaceId ||
    record.installId !== installId ||
    record.listingId !== listingId
  ) {
    throw new PluginError(
      "env_config_invalid",
      "Plugin environment credential scope mismatch.",
      500,
    );
  }
  return assertValidValuesMap(record.values);
}

function encryptMarketInstallCustomEnvValues(
  workspaceId: string,
  installId: string,
  listingId: string,
  values: Record<string, string>,
): Prisma.InputJsonValue {
  return encryptSecretText(
    JSON.stringify({ workspaceId, installId, listingId, values }),
  ) as Prisma.InputJsonValue;
}

function mergeEnvValues(
  requirements: readonly PiPackageEnvRequirement[],
  existingValues: Readonly<Record<string, string>>,
  input: { values?: Record<string, string>; clearKeys?: string[] },
  httpProxies: readonly PiPackageHttpProxy[] = [],
) {
  const byName = new Map(requirements.map((item) => [item.name, item]));
  const proxiedSecretKeys = new Set(
    httpProxies.map((proxy) => proxy.auth.secretEnv),
  );
  const clearSet = new Set(input.clearKeys ?? []);
  for (const key of clearSet) {
    if (!byName.has(key)) {
      throw new PluginError(
        "env_key_unknown",
        `Unknown plugin environment variable: ${key}`,
      );
    }
  }
  for (const key of Object.keys(input.values ?? {})) {
    if (!byName.has(key)) {
      throw new PluginError(
        "env_key_unknown",
        `Unknown plugin environment variable: ${key}`,
      );
    }
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(existingValues)) {
    if (byName.has(key) && typeof value === "string" && value.trim()) {
      next[key] = value;
    }
  }
  for (const key of clearSet) {
    delete next[key];
  }
  for (const [key, rawValue] of Object.entries(input.values ?? {})) {
    if (typeof rawValue !== "string" || rawValue.includes("\0")) {
      throw new PluginError("env_value_invalid", "Invalid environment value.");
    }
    if (rawValue.length > 65_536) {
      throw new PluginError("env_value_invalid", "Environment value too long.");
    }
    if (proxiedSecretKeys.has(key) && /[\r\n]/.test(rawValue)) {
      throw new PluginError(
        "env_value_invalid",
        "Plugin proxy secret cannot contain line breaks.",
      );
    }
    const item = byName.get(key);
    if (!item || clearSet.has(key)) continue;
    const trimmed = rawValue.trim();
    if (!trimmed) {
      if (!isEnvSecret(item)) delete next[key];
      continue;
    }
    if (envValueKind(item) === "url") {
      try {
        next[key] = validatePluginEnvUrl(trimmed);
      } catch {
        throw new PluginError(
          "env_url_invalid",
          `Invalid URL for environment variable ${key}.`,
        );
      }
    } else {
      next[key] = rawValue;
    }
  }
  const configuredKeys = Object.keys(next).sort();
  return {
    values: next,
    configuredKeys,
    clearedKeys: [...clearSet].sort(),
  };
}

export function resolveListingInstallEnvStatus(input: {
  manifest: unknown;
  checksum: string;
  isOfficial: boolean;
  presetConfiguredKeys?: readonly string[];
  installedMode?: string | null;
  customConfiguredKeys?: readonly string[];
}): PluginEnvStatus {
  const parsed = parsePiPackageReleaseManifest(input.manifest, input.checksum);
  return evaluatePluginEnvStatus({
    requirements: parsed.package.toolplane?.env,
    httpProxies: parsed.package.toolplane?.httpProxies,
    isOfficial: input.isOfficial,
    presetConfiguredKeys: input.presetConfiguredKeys,
    installedMode: input.installedMode,
    customConfiguredKeys: input.customConfiguredKeys,
  });
}

export function readOfficialPluginPresetAdminView(input: {
  listingId: string;
  requirements: readonly PiPackageEnvRequirement[];
  preset: {
    configuredKeys: string[];
    encryptedValues: unknown;
    updatedAt: Date;
  } | null;
}): {
  configuredKeys: string[];
  nonSecretValues: Record<string, string>;
  updatedAt: Date | null;
} {
  if (!input.preset) {
    return { configuredKeys: [], nonSecretValues: {}, updatedAt: null };
  }
  const decrypted = decryptOfficialPluginPresetValues(
    input.listingId,
    input.preset.encryptedValues,
  );
  const nonSecretValues: Record<string, string> = {};
  for (const item of input.requirements) {
    if (!isEnvSecret(item) && typeof decrypted[item.name] === "string") {
      nonSecretValues[item.name] = decrypted[item.name];
    }
  }
  return {
    configuredKeys: [...input.preset.configuredKeys],
    nonSecretValues,
    updatedAt: input.preset.updatedAt,
  };
}

export function readWorkspacePluginCustomNonSecretValues(input: {
  workspaceId: string;
  installId: string;
  listingId: string;
  requirements: readonly PiPackageEnvRequirement[];
  envConfig: { encryptedValues: unknown } | null | undefined;
}): Record<string, string> {
  if (!input.envConfig?.encryptedValues) return {};
  const decrypted = decryptMarketInstallCustomEnvValues(
    input.workspaceId,
    input.installId,
    input.listingId,
    input.envConfig.encryptedValues,
  );
  const nonSecretValues: Record<string, string> = {};
  for (const item of input.requirements) {
    if (!isEnvSecret(item) && typeof decrypted[item.name] === "string") {
      nonSecretValues[item.name] = decrypted[item.name];
    }
  }
  return nonSecretValues;
}

export async function saveOfficialPluginEnvPreset(
  adminUserId: string,
  listingId: string,
  rawInput: AdminPluginPresetUpdateInput,
) {
  const input = adminPluginPresetUpdateSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    const listing = await tx.marketListing.findFirst({
      where: { id: listingId, kind: "pi-package" },
      include: {
        githubRegistryResource: {
          select: {
            registry: { select: { official: true, workspaceId: true } },
          },
        },
        releases: {
          where: { reviewStatus: "approved" },
          orderBy: { version: "desc" },
          take: 1,
        },
        officialEnvPreset: true,
      },
    });
    const isOfficial = isOfficialRegistrySource(
      listing?.githubRegistryResource?.registry,
    );
    if (!listing || !isOfficial) {
      throw new PluginError(
        "not_official_plugin",
        "Official plugin listing not found.",
        404,
      );
    }
    const release = listing.releases[0];
    if (!release) {
      throw new PluginError(
        "not_found",
        "Approved plugin release not found.",
        404,
      );
    }
    const manifest = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    const requirements = manifest.package.toolplane?.env ?? [];
    const httpProxies = manifest.package.toolplane?.httpProxies ?? [];
    if (!supportsPlatformPreset({ env: requirements, httpProxies })) {
      throw new PluginError(
        "preset_unsupported",
        "This plugin does not support platform preset credentials.",
        400,
      );
    }
    const existingValues = listing.officialEnvPreset
      ? decryptOfficialPluginPresetValues(
          listing.id,
          listing.officialEnvPreset.encryptedValues,
        )
      : {};
    const merged = mergeEnvValues(
      requirements,
      existingValues,
      input,
      httpProxies,
    );
    if (merged.configuredKeys.length === 0) {
      await tx.officialPluginEnvPreset.deleteMany({
        where: { listingId: listing.id },
      });
    } else {
      const encryptedValues = encryptOfficialPluginPresetValues(
        listing.id,
        merged.values,
      );
      await tx.officialPluginEnvPreset.upsert({
        where: { listingId: listing.id },
        create: {
          listingId: listing.id,
          configuredKeys: merged.configuredKeys,
          encryptedValues,
          updatedById: adminUserId,
        },
        update: {
          configuredKeys: merged.configuredKeys,
          encryptedValues,
          updatedById: adminUserId,
        },
      });
    }
    await writeAudit(tx, {
      actorId: adminUserId,
      action: "plugin.preset.updated",
      targetType: "marketListing",
      targetId: listing.id,
      changes: {
        configuredKeys: merged.configuredKeys,
        clearedKeys: merged.clearedKeys,
      },
    });
    return evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial: true,
      presetConfiguredKeys: merged.configuredKeys,
    });
  });
}

export async function clearOfficialPluginEnvPreset(
  adminUserId: string,
  listingId: string,
) {
  return db.$transaction(async (tx) => {
    const listing = await tx.marketListing.findFirst({
      where: { id: listingId, kind: "pi-package" },
      include: {
        githubRegistryResource: {
          select: {
            registry: { select: { official: true, workspaceId: true } },
          },
        },
      },
    });
    if (
      !listing ||
      !isOfficialRegistrySource(listing.githubRegistryResource?.registry)
    ) {
      throw new PluginError(
        "not_official_plugin",
        "Official plugin listing not found.",
        404,
      );
    }
    await tx.officialPluginEnvPreset.deleteMany({
      where: { listingId: listing.id },
    });
    await writeAudit(tx, {
      actorId: adminUserId,
      action: "plugin.preset.cleared",
      targetType: "marketListing",
      targetId: listing.id,
    });
    return { cleared: true };
  });
}

export async function applyInstallEnvConfigInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    installId: string;
    listingId: string;
    isOfficial: boolean;
    presetConfiguredKeys: readonly string[];
    release: { manifest: unknown; checksum: string };
    existingEnvConfig: {
      mode: string;
      configuredKeys: string[];
      encryptedValues: unknown;
    } | null;
    envConfigInput?: {
      mode?: PluginEnvSourceMode;
      values?: Record<string, string>;
      clearKeys?: string[];
    };
    requireComplete: boolean;
  },
): Promise<PluginEnvStatus> {
  const manifest = parsePiPackageReleaseManifest(
    input.release.manifest,
    input.release.checksum,
  );
  const requirements = manifest.package.toolplane?.env ?? [];
  const httpProxies = manifest.package.toolplane?.httpProxies ?? [];
  if (!requirements.length) {
    if (
      input.envConfigInput &&
      (Object.keys(input.envConfigInput.values ?? {}).length > 0 ||
        (input.envConfigInput.clearKeys?.length ?? 0) > 0)
    ) {
      throw new PluginError(
        "env_key_unknown",
        "This plugin does not declare environment variables.",
      );
    }
    return evaluatePluginEnvStatus({
      requirements: [],
      httpProxies: [],
      isOfficial: input.isOfficial,
    });
  }

  const baseStatus = evaluatePluginEnvStatus({
    requirements,
    httpProxies,
    isOfficial: input.isOfficial,
    presetConfiguredKeys: input.presetConfiguredKeys,
  });

  const existingMode = normalizePluginEnvSourceMode(
    input.existingEnvConfig?.mode,
  );
  const targetMode: PluginEnvSourceMode =
    input.envConfigInput?.mode ??
    existingMode ??
    baseStatus.effectiveDefaultMode ??
    "custom";

  if (targetMode === "platform_preset") {
    if (!baseStatus.presetSupported) {
      throw new PluginError(
        "preset_unsupported",
        "This plugin does not support platform preset credentials.",
        400,
      );
    }
    const status = evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial: input.isOfficial,
      presetConfiguredKeys: input.presetConfiguredKeys,
      installedMode: "platform_preset",
      customConfiguredKeys: input.existingEnvConfig?.configuredKeys ?? [],
    });
    if (!status.complete) {
      throw new PluginError(
        "preset_incomplete",
        `Platform preset is missing required environment variables: ${status.missingRequiredKeys.join(", ")}`,
        400,
      );
    }
    await tx.marketInstallEnvConfig.upsert({
      where: { installId: input.installId },
      create: {
        installId: input.installId,
        workspaceId: input.workspaceId,
        mode: "platform_preset",
        configuredKeys: [],
        encryptedValues: Prisma.DbNull,
        updatedById: input.actorUserId,
      },
      update: {
        mode: "platform_preset",
        updatedById: input.actorUserId,
      },
    });
    if (input.envConfigInput) {
      await writeAudit(tx, {
        actorId: input.actorUserId,
        workspaceId: input.workspaceId,
        action: "plugin.env.updated",
        targetType: "marketInstall",
        targetId: input.installId,
        changes: { listingId: input.listingId, mode: "platform_preset" },
      });
    }
    return status;
  }

  const existingValues = input.existingEnvConfig?.encryptedValues
    ? decryptMarketInstallCustomEnvValues(
        input.workspaceId,
        input.installId,
        input.listingId,
        input.existingEnvConfig.encryptedValues,
      )
    : {};
  const merged =
    input.envConfigInput !== undefined
      ? mergeEnvValues(
          requirements,
          existingValues,
          input.envConfigInput,
          httpProxies,
        )
      : {
          values: existingValues,
          configuredKeys: input.existingEnvConfig?.configuredKeys ?? [],
          clearedKeys: [],
        };
  const status = evaluatePluginEnvStatus({
    requirements,
    httpProxies,
    isOfficial: input.isOfficial,
    presetConfiguredKeys: input.presetConfiguredKeys,
    installedMode: "custom",
    customConfiguredKeys: merged.configuredKeys,
  });
  if (input.requireComplete && !status.complete) {
    throw new PluginError(
      "env_config_incomplete",
      `Missing required plugin environment variables: ${status.missingRequiredKeys.join(", ")}`,
      400,
    );
  }
  const encryptedValues = merged.configuredKeys.length
    ? encryptMarketInstallCustomEnvValues(
        input.workspaceId,
        input.installId,
        input.listingId,
        merged.values,
      )
    : Prisma.DbNull;
  await tx.marketInstallEnvConfig.upsert({
    where: { installId: input.installId },
    create: {
      installId: input.installId,
      workspaceId: input.workspaceId,
      mode: "custom",
      configuredKeys: merged.configuredKeys,
      encryptedValues,
      updatedById: input.actorUserId,
    },
    update: {
      mode: "custom",
      configuredKeys: merged.configuredKeys,
      encryptedValues,
      updatedById: input.actorUserId,
    },
  });
  if (input.envConfigInput) {
    await writeAudit(tx, {
      actorId: input.actorUserId,
      workspaceId: input.workspaceId,
      action: "plugin.env.updated",
      targetType: "marketInstall",
      targetId: input.installId,
      changes: {
        listingId: input.listingId,
        mode: "custom",
        configuredKeys: merged.configuredKeys,
        clearedKeys: merged.clearedKeys,
      },
    });
  }
  return status;
}

export async function updatePluginEnvConfig(
  scope: WorkspaceScope<"plugins">,
  installId: string,
  rawInput: PluginEnvUpdateInput,
) {
  const input = pluginEnvUpdateSchema.parse(rawInput);
  const { id: workspaceId, actorUserId } = scope;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    if (
      !(await tx.workspace.findFirst({
        where: workspaceScopeWhere(scope),
        select: { id: true },
      }))
    ) {
      throw new PluginError("not_authorized", "Workspace access denied.", 403);
    }
    const install = await tx.marketInstall.findFirst({
      where: {
        id: installId,
        targetWorkspaceId: workspaceId,
        status: "ready",
      },
      include: {
        currentRelease: {
          select: { id: true, manifest: true, checksum: true },
        },
        envConfig: {
          select: {
            mode: true,
            configuredKeys: true,
            encryptedValues: true,
          },
        },
        listing: {
          select: {
            id: true,
            kind: true,
            status: true,
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
    if (install?.listing.kind !== "pi-package") {
      throw new PluginError("not_found", "Plugin installation not found.", 404);
    }
    const envStatus = await applyInstallEnvConfigInTransaction(tx, {
      workspaceId,
      actorUserId,
      installId: install.id,
      listingId: install.listingId,
      isOfficial: isOfficialRegistrySource(
        install.listing.githubRegistryResource?.registry,
      ),
      presetConfiguredKeys:
        install.listing.officialEnvPreset?.configuredKeys ?? [],
      release: install.currentRelease,
      existingEnvConfig: install.envConfig,
      envConfigInput: input,
      requireComplete: input.mode === "platform_preset",
    });
    return { installId: install.id, envStatus };
  });
}

export async function assertAgentPluginEnvReady(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  packages: ReadonlyArray<{
    marketInstallId: string;
    release: { manifest: unknown; checksum: string };
  }>,
  agentCredentialNames: readonly string[],
): Promise<void> {
  if (!packages.length) return;
  const reservedNames = new Set(agentCredentialNames);
  const parsedPackages = packages.map((pkg) => ({
    marketInstallId: pkg.marketInstallId,
    toolplane: parsePiPackageReleaseManifest(
      pkg.release.manifest,
      pkg.release.checksum,
    ).package.toolplane,
  }));
  const seenPluginEnvNames = new Set<string>();
  const envInstallIds: string[] = [];
  for (const pkg of parsedPackages) {
    const requirements = pkg.toolplane?.env ?? [];
    if (!requirements.length) continue;
    envInstallIds.push(pkg.marketInstallId);
    for (const item of requirements) {
      if (reservedNames.has(item.name) || seenPluginEnvNames.has(item.name)) {
        throw new Error("PI_PACKAGE_ENV_CONFLICT");
      }
      seenPluginEnvNames.add(item.name);
    }
  }
  if (!envInstallIds.length) return;
  const installs = await tx.marketInstall.findMany({
    where: {
      id: { in: envInstallIds },
      targetWorkspaceId: workspaceId,
      status: { in: ["ready", "uninstalled"] },
    },
    select: {
      id: true,
      envConfig: { select: { mode: true, configuredKeys: true } },
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
  });
  const byInstallId = new Map(installs.map((row) => [row.id, row]));
  for (const pkg of parsedPackages) {
    const requirements = pkg.toolplane?.env ?? [];
    if (!requirements.length) continue;
    const install = byInstallId.get(pkg.marketInstallId);
    if (!install) throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
    const status = evaluatePluginEnvStatus({
      requirements,
      httpProxies: pkg.toolplane?.httpProxies,
      isOfficial: isOfficialRegistrySource(
        install.listing.githubRegistryResource?.registry,
      ),
      presetConfiguredKeys: install.listing.officialEnvPreset?.configuredKeys,
      installedMode: install.envConfig?.mode ?? null,
      customConfiguredKeys: install.envConfig?.configuredKeys,
    });
    if (!status.complete) throw new Error("PI_PACKAGE_ENV_INCOMPLETE");
  }
}

export function resolveLivePluginEnvSourceMode(input: {
  requirements: readonly PiPackageEnvRequirement[];
  httpProxies: readonly PiPackageHttpProxy[];
  isOfficial: boolean;
  presetConfiguredKeys?: readonly string[];
  envConfig?: { mode: string; configuredKeys: string[] } | null;
}): PluginEnvSourceMode | null {
  const status = evaluatePluginEnvStatus({
    requirements: input.requirements,
    httpProxies: input.httpProxies,
    isOfficial: input.isOfficial,
    presetConfiguredKeys: input.presetConfiguredKeys,
    installedMode: input.envConfig?.mode ?? null,
    customConfiguredKeys: input.envConfig?.configuredKeys,
  });
  if (!status.requiresEnv) return null;
  return status.mode ?? status.effectiveDefaultMode;
}
