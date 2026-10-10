import { marketReleaseChecksum } from "@/lib/market/artifact";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";
import { resolvePiPackageMcpPolicy } from "./pi-package-mcp";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";

export type ResolvedAgentPiPackage = {
  marketInstallId: string;
  releaseId: string;
  checksum: string;
  manifest: PiPackageManifestV1;
  mcpBindingsChecksum?: string;
};

export type LoadedAgentPiPackages = {
  runtimeKind: string;
  workspaceId: string;
  piPackages?: Array<{
    marketInstallId: string;
    releaseId: string;
    marketInstall: {
      id: string;
      targetWorkspaceId: string;
      listingId: string;
      status: string;
      resourceMap?: unknown;
      listing: { id: string; kind: string; status: string };
    };
    release: {
      id: string;
      listingId: string;
      reviewStatus: string;
      checksum: string;
      manifest: unknown;
    };
  }>;
};

export function resolveAgentPiPackages(
  agent: LoadedAgentPiPackages,
): ResolvedAgentPiPackage[] {
  if (agent.runtimeKind !== "pi-sdk") return [];
  if (!Array.isArray(agent.piPackages) || agent.piPackages.length > 16)
    throw new Error("PI_PACKAGE_UNAVAILABLE");
  const seen = new Set<string>();
  return [...agent.piPackages]
    .sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId))
    .map((binding) => {
      const { marketInstall: install, release } = binding;
      if (
        seen.has(binding.marketInstallId) ||
        install.id !== binding.marketInstallId ||
        install.targetWorkspaceId !== agent.workspaceId ||
        install.status !== "ready" ||
        install.listing.id !== install.listingId ||
        install.listing.kind !== "pi-package" ||
        install.listing.status !== "published" ||
        release.id !== binding.releaseId ||
        release.listingId !== install.listingId ||
        release.reviewStatus !== "approved"
      ) {
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      }
      seen.add(binding.marketInstallId);
      let manifest: PiPackageManifestV1;
      try {
        manifest = parsePiPackageReleaseManifest(
          release.manifest,
          release.checksum,
        );
      } catch {
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      }
      const mcpPolicy = resolvePiPackageMcpPolicy(
        manifest.package.toolplane?.mcp,
        install.resourceMap,
      );
      return {
        marketInstallId: binding.marketInstallId,
        releaseId: binding.releaseId,
        checksum: release.checksum,
        manifest,
        ...(Object.keys(mcpPolicy).length
          ? { mcpBindingsChecksum: marketReleaseChecksum(mcpPolicy) }
          : {}),
      };
    });
}

export type SkillForPrompt = {
  skillId: string | null;
  skill: {
    slug: string;
    name: string;
    description?: string | null;
    author?: string | null;
    content?: string | null;
    files?: unknown;
  } | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  content?: string | null;
  files?: unknown;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  status?: string | null;
  effort?: string | null;
  source?: string | null;
};

type AttachedSkill = { installedSkill: { id: string } & SkillForPrompt };

type SubAgentChild = {
  id: string;
  name: string;
  slug: string;
  systemPrompt: string | null;
  runtimeKind: string;
};

export type SubAgentRef = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export type LoadedAgentTools = {
  runtimeKind?: string;
  workspaceId?: string;
  piPackages?: LoadedAgentPiPackages["piPackages"];
  servers: { deploymentId: string }[];
  skills: AttachedSkill[];
  toolkits: {
    toolkit: { servers: { deploymentId: string }[]; skills: AttachedSkill[] };
  }[];
  sandboxes?: {
    sandboxId: string;
    isDefault: boolean;
    sandbox: { id: string; deploymentId: string };
  }[];
  knowledgeBases?: {
    knowledgeBase: {
      id: string;
      embeddingModel: string;
      topK: number;
      threshold: number;
      provider: { format: string; baseUrl: string; apiKey: string } | null;
    };
  }[];
  subAgents?: { child: SubAgentChild }[];
};

export function resolveAgentTools(
  agent: LoadedAgentTools,
  sandboxId?: string | null,
): {
  deploymentIds: string[];
  sandboxDeploymentIds: string[];
  mcpToolPolicy?: PiPackageMcpToolPolicy;
  skills: SkillForPrompt[];
  subAgents: SubAgentRef[];
  knowledgeBases?: NonNullable<LoadedAgentTools["knowledgeBases"]>;
} {
  const depSet = new Set<string>();
  const sandboxDepSet = new Set<string>();
  const skillMap = new Map<string, SkillForPrompt>();
  for (const s of agent.servers) depSet.add(s.deploymentId);
  for (const s of agent.sandboxes ?? []) {
    if (s.sandboxId !== sandboxId) continue;
    depSet.add(s.sandbox.deploymentId);
    sandboxDepSet.add(s.sandbox.deploymentId);
  }
  for (const s of agent.skills)
    skillMap.set(s.installedSkill.id, s.installedSkill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) depSet.add(s.deploymentId);
    for (const s of tk.toolkit.skills)
      skillMap.set(s.installedSkill.id, s.installedSkill);
  }
  const mcpToolPolicy: PiPackageMcpToolPolicy = {};
  if (agent.runtimeKind === "pi-sdk") {
    if (!agent.workspaceId) throw new Error("PI_PACKAGE_UNAVAILABLE");
    const packages = resolveAgentPiPackages({
      runtimeKind: agent.runtimeKind,
      workspaceId: agent.workspaceId,
      piPackages: agent.piPackages,
    });
    const directDeployments = new Set(depSet);
    for (const pkg of packages) {
      const binding = agent.piPackages?.find(
        (entry) => entry.marketInstallId === pkg.marketInstallId,
      );
      if (!binding) throw new Error("PI_PACKAGE_UNAVAILABLE");
      const policy = resolvePiPackageMcpPolicy(
        pkg.manifest.package.toolplane?.mcp,
        binding.marketInstall.resourceMap,
      );
      for (const [deploymentId, tools] of Object.entries(policy)) {
        depSet.add(deploymentId);
        if (!directDeployments.has(deploymentId)) {
          mcpToolPolicy[deploymentId] = [
            ...new Set([...(mcpToolPolicy[deploymentId] ?? []), ...tools]),
          ].sort();
        }
      }
    }
  }
  const skills = [...skillMap.values()].filter(
    (s) => s.agentInvocable !== false,
  );

  const subMap = new Map<string, SubAgentRef>();
  for (const link of agent.subAgents ?? []) {
    const c = link.child;
    subMap.set(c.id, {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.runtimeKind === "hermes" ? null : c.systemPrompt,
    });
  }

  return {
    deploymentIds: [...depSet],
    sandboxDeploymentIds: [...sandboxDepSet],
    ...(Object.keys(mcpToolPolicy).length ? { mcpToolPolicy } : {}),
    skills,
    subAgents: [...subMap.values()],
    ...(agent.knowledgeBases ? { knowledgeBases: agent.knowledgeBases } : {}),
  };
}
