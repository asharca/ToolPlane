import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";
import { db } from "@/lib/db";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import {
  isMcpToolExposedToAi,
  mcpToolPolicyFromStored,
  loadMcpToolPolicies,
} from "@/lib/workspace/mcp-tool-exposure";
import { listMcpTools } from "@/lib/process/mcp-client";

export const piPackageClientSchema = z.enum([
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "hermes",
]);
export type PiPackageClient = z.infer<typeof piPackageClientSchema>;
export const piPackageBindingsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    z
      .object({
        deploymentId: z.string().min(1).max(100),
        tools: z.array(z.string().min(1).max(256)).min(1).max(256),
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length <= 64);
export type PiPackageBindings = z.infer<typeof piPackageBindingsSchema>;
export class PiInstallationError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const publicSelect = {
  id: true,
  workspaceId: true,
  userId: true,
  marketInstallId: true,
  releaseId: true,
  client: true,
  label: true,
  status: true,
  bindings: true,
  createdAt: true,
  updatedAt: true,
  lastUsedAt: true,
} as const;

export async function assertPiClientMember(
  workspaceId: string,
  userId: string,
  tx: Prisma.TransactionClient = db,
) {
  const [workspace, user] = await Promise.all([
    tx.workspace.findFirst({
      where: {
        id: workspaceId,
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true },
    }),
    tx.user.findFirst({
      where: { id: userId, status: "active" },
      select: { id: true },
    }),
  ]);
  if (!workspace || !user)
    throw new PiInstallationError("pi_installation_forbidden", 403);
}

async function loadRelease(
  workspaceId: string,
  marketInstallId: string,
  releaseId: string | undefined,
  tx: Prisma.TransactionClient,
) {
  const install = await tx.marketInstall.findFirst({
    where: {
      id: marketInstallId,
      targetWorkspaceId: workspaceId,
      status: "ready",
    },
    include: { listing: true },
  });
  if (
    install?.listing.kind !== "pi-package" ||
    install.listing.status !== "published" ||
    (install.listing.visibility !== "public" &&
      install.listing.publisherWorkspaceId !== workspaceId)
  )
    throw new PiInstallationError("pi_package_unavailable", 404);
  const release = await tx.marketRelease.findFirst({
    where: {
      id: releaseId ?? install.currentReleaseId,
      listingId: install.listingId,
      reviewStatus: "approved",
    },
  });
  if (!release) throw new PiInstallationError("pi_package_unavailable", 404);
  const manifest = parsePiPackageReleaseManifest(
    release.manifest,
    release.checksum,
  );
  return { install, release, manifest };
}

async function validateBindings(
  workspaceId: string,
  manifest: PiPackageManifestV1,
  value: unknown,
  tx: Prisma.TransactionClient,
) {
  const bindings = piPackageBindingsSchema.parse(value);
  const declarations = manifest.package.toolplane?.mcp ?? [];
  if (
    declarations.some(
      (declaration) => !Object.hasOwn(bindings, declaration.key),
    )
  )
    throw new PiInstallationError("pi_package_invalid_bindings");
  for (const [key, binding] of Object.entries(bindings)) {
    const declaration = declarations.find((item) => item.key === key);
    if (
      !declaration ||
      new Set(binding.tools).size !== binding.tools.length ||
      binding.tools.some((tool) => !declaration.tools.includes(tool))
    )
      throw new PiInstallationError("pi_package_invalid_bindings");
    const deployment = await tx.deployment.findFirst({
      where: { id: binding.deploymentId, workspaceId },
      select: { mcpToolExposure: true, mcpAllowedTools: true },
    });
    if (
      !deployment ||
      binding.tools.some(
        (tool) =>
          !isMcpToolExposedToAi(mcpToolPolicyFromStored(deployment), tool),
      )
    )
      throw new PiInstallationError("pi_package_tool_forbidden", 403);
  }
  return bindings;
}

async function validateLiveBindings(value: unknown) {
  const bindings = piPackageBindingsSchema.parse(value);
  for (const binding of Object.values(bindings)) {
    const catalog = await listMcpTools(binding.deploymentId, {
      maxResponseBytes: 2_000_000,
    });
    const names = new Set(catalog.map((tool) => tool.name));
    if (binding.tools.some((tool) => !names.has(tool)))
      throw new PiInstallationError("pi_package_tool_unavailable", 409);
  }
}

function checkClient(
  client: PiPackageClient,
  manifest: PiPackageManifestV1,
  bindings: PiPackageBindings,
) {
  if (
    client !== "pi" &&
    !manifest.package.resources.skills.length &&
    !Object.keys(bindings).length
  )
    throw new PiInstallationError("pi_package_client_unsupported");
}

export async function createPiPackageClientInstallation(input: {
  workspaceId: string;
  userId: string;
  marketInstallId: string;
  client: PiPackageClient;
  label: string;
  bindings: PiPackageBindings;
}) {
  const client = piPackageClientSchema.parse(input.client);
  const label = z.string().trim().min(1).max(100).parse(input.label);
  await assertPiClientMember(input.workspaceId, input.userId);
  // Validate ownership before discovering tools; no network inside the write transaction.
  const preview = await loadRelease(
    input.workspaceId,
    input.marketInstallId,
    undefined,
    db,
  );
  await validateBindings(
    input.workspaceId,
    preview.manifest,
    input.bindings,
    db,
  );
  await validateLiveBindings(input.bindings);
  const token = `tppi_${randomBytes(32).toString("hex")}`;
  const installation = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      await assertPiClientMember(input.workspaceId, input.userId, tx);
      const { release, manifest } = await loadRelease(
        input.workspaceId,
        input.marketInstallId,
        undefined,
        tx,
      );
      const bindings = await validateBindings(
        input.workspaceId,
        manifest,
        input.bindings,
        tx,
      );
      checkClient(client, manifest, bindings);
      return tx.piPackageClientInstallation.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          marketInstallId: input.marketInstallId,
          releaseId: release.id,
          client,
          label,
          bindings,
          tokenHash: tokenHash(token),
        },
        select: publicSelect,
      });
    },
    { isolationLevel: "Serializable" },
  );
  return { installation, token };
}

export async function updatePiPackageClientInstallation(input: {
  workspaceId: string;
  userId: string;
  installationId: string;
  releaseId: string;
  bindings: PiPackageBindings;
  confirmExpandedPrivileges?: boolean;
}) {
  await assertPiClientMember(input.workspaceId, input.userId);
  const previewInstallation = await db.piPackageClientInstallation.findFirst({
    where: {
      id: input.installationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "active",
    },
  });
  if (!previewInstallation)
    throw new PiInstallationError("pi_installation_not_found", 404);
  const preview = await loadRelease(
    input.workspaceId,
    previewInstallation.marketInstallId,
    input.releaseId,
    db,
  );
  await validateBindings(
    input.workspaceId,
    preview.manifest,
    input.bindings,
    db,
  );
  await validateLiveBindings(input.bindings);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      await assertPiClientMember(input.workspaceId, input.userId, tx);
      const current = await tx.piPackageClientInstallation.findFirst({
        where: {
          id: input.installationId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          status: "active",
        },
      });
      if (!current)
        throw new PiInstallationError("pi_installation_not_found", 404);
      const { release, manifest } = await loadRelease(
        input.workspaceId,
        current.marketInstallId,
        input.releaseId,
        tx,
      );
      const bindings = await validateBindings(
        input.workspaceId,
        manifest,
        input.bindings,
        tx,
      );
      checkClient(
        piPackageClientSchema.parse(current.client),
        manifest,
        bindings,
      );
      const oldBindings = piPackageBindingsSchema.parse(current.bindings);
      const expanded = Object.entries(bindings).some(
        ([key, binding]) =>
          oldBindings[key]?.deploymentId !== binding.deploymentId ||
          binding.tools.some((tool) => !oldBindings[key]?.tools.includes(tool)),
      );
      if (expanded && input.confirmExpandedPrivileges !== true)
        throw new PiInstallationError(
          "pi_package_privileges_confirmation_required",
          409,
        );
      return tx.piPackageClientInstallation.update({
        where: { id: current.id },
        data: { releaseId: release.id, bindings },
        select: publicSelect,
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export async function listPiPackageClientInstallations(input: {
  workspaceId: string;
  userId: string;
}) {
  await assertPiClientMember(input.workspaceId, input.userId);
  return db.piPackageClientInstallation.findMany({
    where: { workspaceId: input.workspaceId, userId: input.userId },
    select: publicSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function revokePiPackageClientInstallation(input: {
  workspaceId: string;
  userId: string;
  installationId: string;
}) {
  await assertPiClientMember(input.workspaceId, input.userId);
  const result = await db.piPackageClientInstallation.updateMany({
    where: {
      id: input.installationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    data: { status: "revoked" },
  });
  if (!result.count)
    throw new PiInstallationError("pi_installation_not_found", 404);
}

// This token namespace is deliberately NOT wired into general account authentication.
export async function authenticatePiPackageInstallation(
  installationId: string,
  authorization: string | null,
) {
  const match = /^Bearer (tppi_[a-f0-9]{64})$/.exec(authorization ?? "");
  if (!match)
    throw new PiInstallationError("pi_installation_unauthorized", 401);
  const installation = await db.piPackageClientInstallation.findFirst({
    where: {
      id: installationId,
      tokenHash: tokenHash(match[1]),
      status: "active",
    },
  });
  if (!installation)
    throw new PiInstallationError("pi_installation_unauthorized", 401);
  await assertPiClientMember(installation.workspaceId, installation.userId);
  const loaded = await loadRelease(
    installation.workspaceId,
    installation.marketInstallId,
    installation.releaseId,
    db,
  );
  const bindings = piPackageBindingsSchema.parse(installation.bindings);
  const declarations = loaded.manifest.package.toolplane?.mcp ?? [];
  if (
    Object.entries(bindings).some(
      ([key, binding]) =>
        !declarations.some(
          (declaration) =>
            declaration.key === key &&
            binding.tools.every((tool) => declaration.tools.includes(tool)),
        ),
    )
  )
    throw new PiInstallationError("pi_package_invalid_bindings", 403);
  const policies = await loadMcpToolPolicies(
    Object.values(bindings).map((binding) => binding.deploymentId),
    installation.workspaceId,
  );
  for (const [key, binding] of Object.entries(bindings)) {
    binding.tools = binding.tools.filter((tool) =>
      isMcpToolExposedToAi(policies.get(binding.deploymentId), tool),
    );
    if (!binding.tools.length) delete bindings[key];
  }
  await db.piPackageClientInstallation.update({
    where: { id: installation.id },
    data: { lastUsedAt: new Date() },
  });
  return { installation, bindings, ...loaded };
}
