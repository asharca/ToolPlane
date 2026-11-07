import "server-only";
import type { getAgentPageData } from "@/lib/agents/queries";
import { type listPlugins, pluginReleaseLabel } from "@/lib/plugins/catalog";
import { readCapabilities } from "@/lib/plugins/capabilities";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";

type AgentPluginState = Pick<
  NonNullable<Awaited<ReturnType<typeof getAgentPageData>>>,
  "runtimeKind" | "piPackages"
>;

/** Shared settings/API projection; never changes installs or Agent drafts. */
export function buildAgentPluginOptions(
  plugins: Awaited<ReturnType<typeof listPlugins>>["items"],
  agent: AgentPluginState,
) {
  return plugins.flatMap((plugin) => {
    const install = plugin.install;
    if (!install) return [];
    const enabled = agent.piPackages.find(
      (pkg) => pkg.marketInstallId === install.id,
    );
    const snapshot = install.currentRelease
      ? parsePiPackageReleaseManifest(
          install.currentRelease.manifest,
          install.currentRelease.checksum,
        ).package
      : null;
    const compatible = snapshot?.runtime.kind === agent.runtimeKind;
    if (!compatible && !enabled) return [];
    const available =
      install.status === "ready" && plugin.status === "published" && compatible;
    const from = readCapabilities(enabled?.release.releaseSummary);
    const to = readCapabilities(enabled?.targetRelease?.releaseSummary);
    const previousMcp = new Map(
      from?.mcp.map(({ key, tools }) => [key, new Set(tools)]),
    );
    return [
      {
        marketInstallId: install.id,
        listingId: plugin.id,
        name: plugin.name,
        summary: plugin.summary,
        skillCount: snapshot?.resources.skills.length ?? 0,
        extensionCount: snapshot?.resources.extensions.length ?? 0,
        mcpRequirementCount: snapshot?.toolplane?.mcp.length ?? 0,
        capabilities: snapshot
          ? {
              runtimeKind: snapshot.runtime.kind,
              hooks: snapshot.resources.hooks ?? [],
              extensions: snapshot.resources.extensions,
              tools: snapshot.resources.tools ?? [],
              commands: snapshot.resources.commands ?? [],
            }
          : null,
        currentReleaseId: install.currentReleaseId,
        currentVersion: install.currentRelease
          ? pluginReleaseLabel(install.currentRelease)
          : null,
        currentAvailable:
          available && install.currentRelease?.reviewStatus === "approved",
        enabledReleaseId: enabled?.releaseId ?? null,
        enabledVersion: enabled ? pluginReleaseLabel(enabled.release) : null,
        syncStatus: enabled?.syncStatus ?? "synced",
        syncError: enabled?.syncError ?? null,
        targetVersion: enabled?.targetRelease
          ? pluginReleaseLabel(enabled.targetRelease)
          : null,
        targetReleaseId: enabled?.targetReleaseId ?? null,
        capabilityDiff:
          from && to
            ? {
                addedMcp: to.mcp.flatMap(({ key, tools }) => {
                  const previous = previousMcp.get(key);
                  const addedTools = tools.filter(
                    (tool) => !previous?.has(tool),
                  );
                  return !previous || addedTools.length
                    ? [
                        {
                          key,
                          tools: addedTools,
                          requirementAdded: !previous,
                        },
                      ]
                    : [];
                }),
                codeChanged: from.codeDigest !== to.codeDigest,
              }
            : null,
      },
    ];
  });
}
