/** Executable settings a revision upgrade can change, shared by Agents and Assistants. */
export type RevisionChangedField =
  | "systemPrompt"
  | "model"
  | "modelParameters"
  | "maxSteps"
  | "packages"
  | "knowledge"
  | "environment"
  | "externalSandboxes"
  | "builtinTools"
  | "a2a";

export type RevisionMcpToolChange = {
  deploymentId: string;
  /** Display name resolved by the server; null when the deployment is gone. */
  name: string | null;
  tools: string[];
};

export type RevisionUpgradeDiff = {
  fromVersion: number | null;
  toVersion: number;
  changedFields: RevisionChangedField[];
  mcpGrantsAdded: RevisionMcpToolChange[];
  mcpGrantsRemoved: RevisionMcpToolChange[];
  mcpToolsAdded: RevisionMcpToolChange[];
  mcpToolsRemoved: RevisionMcpToolChange[];
  /** Skill display names; Assistant revisions carry no skills. */
  skillsAdded: string[];
  skillsRemoved: string[];
  skillsUpdated: string[];
  grantsNewPermissions: boolean;
};

type McpGrantLike = { deploymentId: string; allowedToolNames: string[] };

/** MCP part of a revision diff; `name` resolves deployment display names. */
export function diffRevisionMcpGrants(
  from: readonly McpGrantLike[],
  to: readonly McpGrantLike[],
  name: (deploymentId: string) => string | null = () => null,
): Pick<
  RevisionUpgradeDiff,
  "mcpGrantsAdded" | "mcpGrantsRemoved" | "mcpToolsAdded" | "mcpToolsRemoved"
> {
  const fromGrants = new Map(from.map((grant) => [grant.deploymentId, grant]));
  const toGrants = new Map(to.map((grant) => [grant.deploymentId, grant]));
  const entry = (deploymentId: string, tools: string[]) => ({
    deploymentId,
    name: name(deploymentId),
    tools,
  });
  const result = {
    mcpGrantsAdded: [...toGrants.values()]
      .filter((grant) => !fromGrants.has(grant.deploymentId))
      .map((grant) => entry(grant.deploymentId, grant.allowedToolNames)),
    mcpGrantsRemoved: [...fromGrants.values()]
      .filter((grant) => !toGrants.has(grant.deploymentId))
      .map((grant) => entry(grant.deploymentId, grant.allowedToolNames)),
    mcpToolsAdded: [] as RevisionMcpToolChange[],
    mcpToolsRemoved: [] as RevisionMcpToolChange[],
  };
  for (const [deploymentId, toGrant] of toGrants) {
    const fromGrant = fromGrants.get(deploymentId);
    if (!fromGrant) continue;
    const added = toGrant.allowedToolNames.filter(
      (tool) => !fromGrant.allowedToolNames.includes(tool),
    );
    const removed = fromGrant.allowedToolNames.filter(
      (tool) => !toGrant.allowedToolNames.includes(tool),
    );
    if (added.length) result.mcpToolsAdded.push(entry(deploymentId, added));
    if (removed.length)
      result.mcpToolsRemoved.push(entry(deploymentId, removed));
  }
  return result;
}

export function revisionGrantsNewPermissions(
  diff: Pick<RevisionUpgradeDiff, "mcpGrantsAdded" | "mcpToolsAdded">,
): boolean {
  return diff.mcpGrantsAdded.length > 0 || diff.mcpToolsAdded.length > 0;
}

export const REVISION_CHANGELOG_PAGE_SIZE = 20;

export type RevisionChangelogPage = {
  currentVersion: number;
  entries: Array<{
    version: number;
    createdAt: string;
    /** Null for the first revision, which has nothing to compare against. */
    diff: RevisionUpgradeDiff | null;
  }>;
  nextBeforeVersion: number | null;
};

/**
 * `revisions` is newest first with up to one row beyond the page, which only
 * supplies the predecessor of the page's oldest entry.
 */
export function buildRevisionChangelogPage<
  T extends { version: number; createdAt: Date },
>(
  currentVersion: number,
  revisions: readonly T[],
  diff: (from: T, to: T) => RevisionUpgradeDiff,
): RevisionChangelogPage {
  const page = revisions.slice(0, REVISION_CHANGELOG_PAGE_SIZE);
  return {
    currentVersion,
    entries: page.map((revision, index) => {
      const previous = revisions[index + 1];
      return {
        version: revision.version,
        createdAt: revision.createdAt.toISOString(),
        diff: previous ? diff(previous, revision) : null,
      };
    }),
    nextBeforeVersion:
      revisions.length > REVISION_CHANGELOG_PAGE_SIZE
        ? page[page.length - 1].version
        : null,
  };
}
