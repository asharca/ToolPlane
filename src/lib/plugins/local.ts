import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  PrivatePluginInputSchema,
  type PrivatePluginInput,
} from "@/lib/agents/capability-contracts";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import {
  parsePiPackageReleaseManifest,
  projectPiPackageSummary,
  scanPiPackageReleaseManifest,
} from "@/lib/pi-packages/manifest";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";
import { computePluginCapabilities } from "./capabilities";
import { readPluginChangelog } from "./changelog";
import { PluginError, requirePluginWorkspace } from "./catalog";
import { updatePlugin } from "./installs";
import { resolveOmpPluginResources } from "../../../scripts/omp-plugin-resources.mjs";

function resolveDeclaredSubagents(
  declaration: unknown,
  enabledFeatures?: string[] | null,
) {
  const parsed = z
    .object({
      subagents: z.array(z.string()).optional(),
      features: z
        .record(
          z.string(),
          z
            .object({
              default: z.boolean().optional(),
              subagents: z.array(z.string()).optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .parse(declaration);
  if (
    parsed.subagents === undefined &&
    !Object.values(parsed.features ?? {}).some(
      (feature) => feature.subagents !== undefined,
    )
  )
    return undefined;
  const features =
    enabledFeatures ??
    Object.entries(parsed.features ?? {})
      .filter(([, feature]) => feature.default)
      .map(([name]) => name);
  return [
    ...new Set([
      ...(parsed.subagents ?? []),
      ...features.flatMap((name) => parsed.features?.[name]?.subagents ?? []),
    ]),
  ];
}

export function buildPrivatePluginManifest(input: PrivatePluginInput) {
  const filePaths = new Set(input.files.map((file) => file.path));
  if (filePaths.size !== input.files.length)
    throw new PluginError("PLUGIN_FILES_INVALID", "Duplicate file path.");
  try {
    let resources = {
      hooks: input.hooks,
      extensions: input.extensions,
      tools: input.tools,
      commands: input.commands,
    };
    let subagents = input.subagents;
    if (input.runtimeKind === "omp") {
      const packageFile = input.files.find(
        (file) => file.path === "package.json",
      );
      const packageMetadata: unknown = packageFile
        ? JSON.parse(
            Buffer.from(
              packageFile.content,
              packageFile.encoding === "base64" ? "base64" : "utf8",
            ).toString("utf8"),
          )
        : null;
      const declaration =
        packageMetadata && typeof packageMetadata === "object"
          ? (("omp" in packageMetadata ? packageMetadata.omp : undefined) ??
            ("pi" in packageMetadata ? packageMetadata.pi : undefined))
          : null;
      if (
        declaration &&
        typeof declaration === "object" &&
        !Array.isArray(declaration)
      ) {
        const files = input.files.map((file) => ({
          path: file.path,
          content: file.path.endsWith("package.json")
            ? Buffer.from(
                file.content,
                file.encoding === "base64" ? "base64" : "utf8",
              ).toString("utf8")
            : "",
        }));
        try {
          resources = resolveOmpPluginResources(
            { path: "/package", manifest: packageMetadata },
            files,
            { enabledFeatures: input.enabledFeatures },
          );
          subagents =
            resolveDeclaredSubagents(declaration, input.enabledFeatures) ??
            subagents;
        } catch {
          throw new PluginError(
            "PLUGIN_FEATURES_UNAVAILABLE",
            "Selected features or declared entrypoints are unavailable in the frozen dependency tree.",
          );
        }
      } else if (input.enabledFeatures?.length) {
        throw new PluginError(
          "PLUGIN_FEATURES_UNAVAILABLE",
          "Plugin has no frozen feature manifest.",
        );
      }
    }
    const manifest = parsePiPackageReleaseManifest({
      schemaVersion: 1,
      kind: "pi-package",
      listing: {
        slug: input.name.replace(/^@/, "").replace(/\//g, "-").slice(0, 100),
        name: input.name,
        summary: "Workspace-private imported plugin",
        iconUrl: null,
        tags: [],
        author: "workspace",
      },
      package: {
        source: {
          kind: "toolplane",
          requested: `toolplane:${input.name}@${input.version}`,
          name: input.name,
          version: input.version,
        },
        name: input.name,
        version: input.version,
        runtime: {
          kind: input.runtimeKind,
          ...(input.runtimeKind === "omp"
            ? { ompVersion: "18.14.0" }
            : { piVersion: "0.87.1" }),
          nodeMajor: 26,
          platform: input.platform ?? "any",
          arch: input.arch ?? "any",
        },
        root: "package",
        resources: {
          extensions: resources.extensions.map((path) => `package/${path}`),
          hooks: resources.hooks.map((path) => `package/${path}`),
          tools: resources.tools.map((path) => `package/${path}`),
          commands: resources.commands.map((path) => `package/${path}`),
          ...(subagents === undefined
            ? {}
            : { subagents: subagents.map((path) => `package/${path}`) }),
          skills: [],
          prompts: [],
          themes: [],
        },
        entries: input.files.map((file) => {
          const bytes = Buffer.from(
            file.content,
            file.encoding === "base64" ? "base64" : "utf8",
          );
          if (
            file.encoding === "base64" &&
            bytes.toString("base64") !== file.content
          )
            throw new PluginError(
              "PLUGIN_FILES_INVALID",
              "Invalid base64 file.",
            );
          const elf =
            bytes.length >= 20 &&
            bytes[0] === 127 &&
            bytes[1] === 69 &&
            bytes[2] === 76 &&
            bytes[3] === 70;
          if (elf || file.path.endsWith(".node")) {
            const machine = elf && bytes[5] === 1 ? bytes.readUInt16LE(18) : 0;
            if (
              input.platform !== "linux" ||
              !["x64", "arm64"].includes(input.arch ?? "") ||
              machine !== (input.arch === "x64" ? 62 : 183)
            )
              throw new PluginError(
                "PLUGIN_NATIVE_PLATFORM_INVALID",
                "Native dependencies require a matching Linux architecture pin.",
              );
          }
          return {
            type: "file",
            path: `package/${file.path}`,
            contentEncoding: "base64",
            executable: file.mode === 493,
            content: bytes.toString("base64"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
        toolplane: {
          schemaVersion: 1,
          mcp: [],
          ...(input.config ? { config: input.config } : {}),
          ...(input.nativeRoleModels
            ? {
                nativeRoleModels: Object.fromEntries(
                  Object.entries(input.nativeRoleModels).map(
                    ([path, model]) => [`package/${path}`, model],
                  ),
                ),
              }
            : {}),
          ...(input.enabledFeatures !== undefined
            ? { enabledFeatures: input.enabledFeatures }
            : {}),
        },
      },
    });
    if (scanPiPackageReleaseManifest(manifest).status !== "passed")
      throw new PluginError(
        "PLUGIN_CONTAINS_SECRET",
        "Plugin contains credentials.",
      );
    return manifest;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(
      "PLUGIN_FILES_INVALID",
      "Plugin artifact paths, entrypoints or dependency closure are invalid.",
    );
  }
}

/** A private resource uses the same immutable plugin releases and installations. */
export async function intakePrivatePlugin(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  value: unknown,
  preserveExisting = false,
) {
  await requirePluginWorkspace(workspaceId, userId, true, tx);
  const parsed = PrivatePluginInputSchema.safeParse(value);
  if (!parsed.success)
    throw new PluginError("PLUGIN_INVALID", "Invalid private plugin.");
  const manifest = buildPrivatePluginManifest(parsed.data);
  return persistPrivatePluginManifest(
    tx,
    workspaceId,
    userId,
    manifest,
    undefined,
    preserveExisting,
  );
}

async function persistPrivatePluginManifest(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  manifest: PiPackageManifestV1,
  resourceMap: Prisma.InputJsonValue = { kind: "pi-package", mcpBindings: {} },
  preserveExisting = false,
) {
  const checksum = marketReleaseChecksum(manifest);
  const slug = `${manifest.package.name.replace(/^@/, "").replace(/\//g, "-").slice(0, 60)}-${checksum.slice(0, 16)}`;
  const namespace = `private-${workspaceId}`;
  let listing = await tx.marketListing.findUnique({
    where: { namespace_slug: { namespace, slug } },
  });
  if (listing && preserveExisting) {
    const existing = await tx.marketInstall.findUnique({
      where: {
        targetWorkspaceId_listingId: {
          targetWorkspaceId: workspaceId,
          listingId: listing.id,
        },
      },
    });
    const release = await tx.marketRelease.findFirst({
      where: { listingId: listing.id, checksum },
    });
    if (existing) {
      if (
        existing.status !== "ready" ||
        !release ||
        existing.currentReleaseId !== release.id
      )
        throw new PluginError(
          "PLUGIN_IMPORT_EXISTING_CONFLICT",
          "Existing plugin installation must be resolved before importing.",
          409,
        );
      return { installId: existing.id, releaseId: release.id };
    }
  }
  if (!listing)
    listing = await tx.marketListing.create({
      data: {
        kind: "pi-package",
        namespace,
        slug,
        name: manifest.package.name,
        publisherWorkspaceId: workspaceId,
        publishedById: userId,
        visibility: "private",
        status: "published",
        metadata: { intake: "local" },
        latestVersion: 1,
      },
    });
  let release = await tx.marketRelease.findFirst({
    where: { listingId: listing.id, checksum },
  });
  if (!release) {
    const changelog = readPluginChangelog(manifest.package);
    release = await tx.marketRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifest: manifest as Prisma.InputJsonValue,
        releaseNotes:
          changelog?.kind === "release-notes" ? changelog.text : null,
        checksum,
        releaseSummary: {
          ...projectPiPackageSummary(manifest.package),
          capabilities: computePluginCapabilities(manifest),
        } as Prisma.InputJsonValue,
        scanResult: { status: "passed" },
        reviewStatus: "approved",
        reviewedById: userId,
        reviewedAt: new Date(),
      },
    });
  }
  await tx.marketListing.update({
    where: { id: listing.id },
    data: { latestReleaseId: release.id },
  });
  const install = await tx.marketInstall.upsert({
    where: {
      targetWorkspaceId_listingId: {
        targetWorkspaceId: workspaceId,
        listingId: listing.id,
      },
    },
    create: {
      targetWorkspaceId: workspaceId,
      listingId: listing.id,
      currentReleaseId: release.id,
      installedById: userId,
      idempotencyKey: `local:${checksum}`,
      status: "ready",
      resourceMap,
    },
    update: { status: "ready", resourceMap },
  });
  return { installId: install.id, releaseId: release.id };
}

export async function createPrivatePlugin(
  workspaceId: string,
  userId: string,
  value: unknown,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      return intakePrivatePlugin(tx, workspaceId, userId, value);
    },
    { timeout: 30_000 },
  );
}

export async function pluginInstallConfig(
  workspaceId: string,
  userId: string,
  installId: string,
  config?: PrivatePluginInput["config"],
  enabledFeatures?: string[] | null,
) {
  await requirePluginWorkspace(workspaceId, userId, config !== undefined);
  const install = await db.marketInstall.findFirst({
    where: { id: installId, targetWorkspaceId: workspaceId, status: "ready" },
    include: { currentRelease: true },
  });
  if (!install) throw new PluginError("not_found", "Plugin not found.", 404);
  const manifest = parsePiPackageReleaseManifest(
    install.currentRelease.manifest,
    install.currentRelease.checksum,
  );
  if (config === undefined)
    return {
      config: manifest.package.toolplane?.config ?? {},
      hooks: manifest.package.resources.hooks ?? [],
      runtimeKind: manifest.package.runtime.kind,
      enabledFeatures: manifest.package.toolplane?.enabledFeatures ?? null,
    };
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await requirePluginWorkspace(workspaceId, userId, true, tx);
    const derived = structuredClone(manifest);
    derived.package.toolplane = {
      ...derived.package.toolplane,
      schemaVersion: 1,
      mcp: derived.package.toolplane?.mcp ?? [],
      config,
      ...(enabledFeatures === undefined ? {} : { enabledFeatures }),
    };
    if (
      enabledFeatures !== undefined &&
      derived.package.runtime.kind === "omp"
    ) {
      const packageJson = derived.package.entries.find(
        (entry) =>
          entry.type === "file" && entry.path === "package/package.json",
      );
      if (packageJson?.type !== "file")
        throw new PluginError(
          "PLUGIN_FEATURES_UNAVAILABLE",
          "Plugin has no frozen feature manifest.",
        );
      try {
        const files = derived.package.entries
          .filter((entry) => entry.type === "file")
          .map((entry) => ({
            path: entry.path.slice("package/".length),
            content: entry.path.endsWith("/package.json")
              ? Buffer.from(entry.content, "base64").toString("utf8")
              : "",
          }));
        const resources = resolveOmpPluginResources(
          {
            path: "/package",
            manifest: JSON.parse(
              Buffer.from(packageJson.content, "base64").toString("utf8"),
            ),
          },
          files,
          { enabledFeatures },
        );
        derived.package.resources = {
          ...derived.package.resources,
          ...Object.fromEntries(
            Object.entries(resources).map(([kind, paths]) => [
              kind,
              paths.map((path) => `package/${path}`),
            ]),
          ),
        };
        const metadata = z
          .object({ omp: z.unknown().optional(), pi: z.unknown().optional() })
          .passthrough()
          .parse(
            JSON.parse(
              Buffer.from(packageJson.content, "base64").toString("utf8"),
            ),
          );
        const subagents = resolveDeclaredSubagents(
          metadata.omp ?? metadata.pi,
          enabledFeatures,
        );
        if (subagents !== undefined)
          derived.package.resources.subagents = subagents.map(
            (path) => `package/${path}`,
          );
      } catch {
        throw new PluginError(
          "PLUGIN_FEATURES_UNAVAILABLE",
          "Selected features are unavailable in the frozen dependency tree.",
        );
      }
    }
    parsePiPackageReleaseManifest(derived);
    if (scanPiPackageReleaseManifest(derived).status !== "passed")
      throw new PluginError(
        "PLUGIN_CONTAINS_SECRET",
        "Plugin configuration contains credentials.",
      );
    const result = await persistPrivatePluginManifest(
      tx,
      workspaceId,
      userId,
      derived,
      (install.resourceMap ?? {}) as Prisma.InputJsonValue,
    );
    if (result.installId !== installId) {
      const bindings = await tx.agentPiPackage.findMany({
        where: { marketInstallId: installId, agent: { workspaceId } },
      });
      for (const binding of bindings) {
        await tx.agentPiPackage.upsert({
          where: {
            agentId_marketInstallId: {
              agentId: binding.agentId,
              marketInstallId: result.installId,
            },
          },
          create: {
            agentId: binding.agentId,
            marketInstallId: result.installId,
            releaseId: result.releaseId,
          },
          update: { releaseId: result.releaseId },
        });
        await tx.agentPiPackage.delete({
          where: {
            agentId_marketInstallId: {
              agentId: binding.agentId,
              marketInstallId: installId,
            },
          },
        });
      }
    }
    return result;
  });
}

export async function appendPrivatePluginVersion(
  workspaceId: string,
  userId: string,
  installId: string,
  value: unknown,
) {
  const parsed = PrivatePluginInputSchema.safeParse(value);
  if (!parsed.success)
    throw new PluginError("PLUGIN_INVALID", "Invalid private plugin.");
  const manifest = buildPrivatePluginManifest(parsed.data);
  const release = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(workspaceId, userId, true, tx);
      const install = await tx.marketInstall.findFirst({
        where: {
          id: installId,
          targetWorkspaceId: workspaceId,
          status: "ready",
          listing: {
            publisherWorkspaceId: workspaceId,
            visibility: "private",
            githubRegistryResource: null,
          },
        },
        include: { listing: true, currentRelease: true },
      });
      if (!install)
        throw new PluginError(
          "not_found",
          "Private local plugin not found.",
          404,
        );
      const prior = parsePiPackageReleaseManifest(
        install.currentRelease.manifest,
        install.currentRelease.checksum,
      );
      if (
        manifest.package.name !== prior.package.name ||
        manifest.package.runtime.kind !== prior.package.runtime.kind
      )
        throw new PluginError(
          "PLUGIN_IDENTITY_MISMATCH",
          "Plugin identity or runtime cannot change.",
        );
      const checksum = marketReleaseChecksum(manifest);
      const existing = await tx.marketRelease.findFirst({
        where: { listingId: install.listingId, checksum },
      });
      if (existing) return existing;
      const changelog = readPluginChangelog(manifest.package);
      const created = await tx.marketRelease.create({
        data: {
          listingId: install.listingId,
          version: install.listing.latestVersion + 1,
          manifest: manifest as Prisma.InputJsonValue,
          releaseNotes:
            changelog?.kind === "release-notes" ? changelog.text : null,
          checksum,
          releaseSummary: {
            ...projectPiPackageSummary(manifest.package),
            capabilities: computePluginCapabilities(manifest),
          } as Prisma.InputJsonValue,
          scanResult: { status: "passed" },
          reviewStatus: "approved",
          reviewedById: userId,
          reviewedAt: new Date(),
        },
      });
      await tx.marketListing.update({
        where: { id: install.listingId },
        data: { latestReleaseId: created.id, latestVersion: created.version },
      });
      return created;
    },
    { timeout: 30_000 },
  );
  await updatePlugin(workspaceId, userId, installId, release.id);
  return { installId, releaseId: release.id };
}
