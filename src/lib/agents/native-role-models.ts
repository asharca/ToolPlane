import "server-only";
import type { Prisma, ProviderModel } from "@prisma/client";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { assertMarketReleasesExecutable } from "@/lib/pi-packages/revocation";
import { readPluginSubagentMembers } from "@/lib/plugins/subagent-members";
import type { AgentRevisionConfig } from "./revision-types";
import { resolveAgentModelOverride } from "./turn-model";

export type ResolvedNativeRoleModel = NonNullable<
  AgentRevisionConfig["nativeRoleModels"]
>[number] & {
  provider: { id: string; name: string; format: string };
  metadata: Pick<
    ProviderModel,
    "contextWindow" | "maxOutputTokens" | "inputModalities" | "capabilities"
  > | null;
};

/** Native role authority is part of the immutable package and Agent revision. */
export function captureNativeRoleModels(
  packages: readonly {
    marketInstallId: string;
    releaseId: string;
    manifest: PiPackageManifestV1;
  }[],
) {
  return packages.flatMap((pkg) =>
    readPluginSubagentMembers(pkg.manifest.package).flatMap((role) =>
      role.modelMapping
        ? [
            {
              marketInstallId: pkg.marketInstallId,
              releaseId: pkg.releaseId,
              path: role.path,
              name: role.name,
              ...role.modelMapping,
            },
          ]
        : [],
    ),
  );
}

/** A revision pin is a ceiling; a current binding, release and model can revoke it. */
export async function resolveNativeRoleModels(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  config: AgentRevisionConfig,
) {
  if (config.runtimeKind !== "omp" || config.subagentMode !== "native")
    return [];
  const result: ResolvedNativeRoleModel[] = [];
  for (const grant of config.nativeRoleModels ?? []) {
    const pin = config.packages.find(
      (pkg) =>
        pkg.marketInstallId === grant.marketInstallId &&
        pkg.releaseId === grant.releaseId,
    );
    if (!pin) continue;
    const binding = await tx.agentPiPackage.findFirst({
      where: {
        agentId,
        marketInstallId: grant.marketInstallId,
        agent: {
          workspaceId,
          retiredAt: null,
          subagentMode: "native",
          workspace: { status: "active" },
        },
        marketInstall: { targetWorkspaceId: workspaceId, status: "ready" },
      },
      include: { release: true, marketInstall: { include: { listing: true } } },
    });
    if (!binding) continue;
    const release = await tx.marketRelease.findUnique({
      where: { id: pin.releaseId },
    });
    if (
      !release ||
      release.listingId !== binding.marketInstall.listingId ||
      release.checksum !== pin.integrity
    )
      continue;
    await assertMarketReleasesExecutable(tx, [release.id, binding.releaseId]);
    const pinned = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    const live = parsePiPackageReleaseManifest(
      binding.release.manifest,
      binding.release.checksum,
    );
    if (
      ![pinned, live].every((manifest) =>
        readPluginSubagentMembers(manifest.package).some(
          (role) =>
            role.path === grant.path &&
            role.name === grant.name &&
            role.modelMapping?.providerId === grant.providerId &&
            role.modelMapping.model === grant.model,
        ),
      )
    )
      continue;
    const selected = await resolveAgentModelOverride(
      workspaceId,
      { providerId: grant.providerId, model: grant.model },
      "omp",
      tx,
    );
    const metadata = await tx.providerModel.findUnique({
      where: {
        providerId_modelId: {
          providerId: grant.providerId,
          modelId: grant.model,
        },
      },
      select: {
        contextWindow: true,
        maxOutputTokens: true,
        inputModalities: true,
        capabilities: true,
      },
    });
    result.push({
      ...grant,
      provider: {
        id: selected.provider.id,
        name: selected.provider.name,
        format: selected.provider.format,
      },
      metadata,
    });
  }
  return result;
}
