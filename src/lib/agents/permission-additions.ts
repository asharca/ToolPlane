import type { AgentRevisionConfig } from "./revision-types";
import { agentRuntimeBuiltinToolGroups } from "./runtime-kind";

export type AgentPermissionAddition = {
  kind:
    | "builtin"
    | "skill"
    | "package"
    | "knowledge"
    | "credential"
    | "environment"
    | "delegation";
  resourceId: string;
  values: string[];
};

// Compare execution authority, not prompt text, model selection or array order.
// Changed executable content needs consent even when its resource ID is unchanged.
export function agentPermissionAdditions(
  previous: AgentRevisionConfig | null,
  next: AgentRevisionConfig,
) {
  const additions: AgentPermissionAddition[] = [];
  const add = (
    kind: AgentPermissionAddition["kind"],
    resourceId: string,
    values: string[],
  ) => {
    if (values.length) additions.push({ kind, resourceId, values });
  };
  const tools =
    previous?.disabledBuiltinTools ??
    agentRuntimeBuiltinToolGroups(next.runtimeKind).flatMap(
      (group) => group.tools,
    );
  add(
    "builtin",
    "builtin",
    tools.filter((tool) => !next.disabledBuiltinTools.includes(tool)),
  );
  for (const skill of next.skills) {
    const old = previous?.skills.find(
      (item) => item.installedSkillId === skill.installedSkillId,
    );
    if (
      !old ||
      old.checksum !== skill.checksum ||
      (!old.agentInvocable && skill.agentInvocable) ||
      (!old.userInvocable && skill.userInvocable)
    )
      add("skill", skill.installedSkillId, [skill.name]);
  }
  for (const pkg of next.packages) {
    if (
      !previous?.packages.some(
        (old) =>
          old.marketInstallId === pkg.marketInstallId &&
          old.releaseId === pkg.releaseId &&
          old.integrity === pkg.integrity,
      )
    )
      add("package", pkg.marketInstallId, [pkg.releaseId]);
  }
  for (const child of next.subagents ?? []) {
    if (
      !(previous?.subagents ?? []).some(
        (old) =>
          old.subagentId === child.subagentId &&
          old.versionId === child.versionId &&
          old.checksum === child.checksum,
      )
    )
      add("delegation", child.subagentId, [child.versionId]);
  }
  for (const role of next.nativeRoleModels ?? []) {
    if (
      !(previous?.nativeRoleModels ?? []).some(
        (old) =>
          old.marketInstallId === role.marketInstallId &&
          old.releaseId === role.releaseId &&
          old.path === role.path &&
          old.providerId === role.providerId &&
          old.model === role.model,
      )
    )
      add("delegation", role.marketInstallId, [
        `${role.name}:${role.providerId}/${role.model}`,
      ]);
  }
  if (next.subagentMode === "native") {
    const prior =
      previous?.subagentMode === "native"
        ? previous.nativeSubagentPolicy
        : undefined;
    const policy = next.nativeSubagentPolicy;
    if (
      policy &&
      (!prior ||
        policy.maxConcurrency > prior.maxConcurrency ||
        policy.maxDepth > prior.maxDepth)
    )
      add("delegation", "native", [
        "native",
        `maxConcurrency:${policy.maxConcurrency}`,
        `maxDepth:${policy.maxDepth}`,
      ]);
  }
  for (const id of next.knowledgeBaseIds) {
    if (!previous?.knowledgeBaseIds.includes(id)) add("knowledge", id, [id]);
  }
  for (const credential of next.environment.credentialReferences) {
    if (
      !previous?.environment.credentialReferences.some(
        (old) =>
          old.name === credential.name &&
          old.credentialId === credential.credentialId,
      )
    )
      add("credential", credential.credentialId, [credential.name]);
  }
  const environmentChanges: string[] = [];
  const oldEnv = previous?.environment;
  const env = next.environment;
  if (
    !oldEnv ||
    oldEnv.image !== env.image ||
    previous?.runtimeKind !== next.runtimeKind ||
    ("piVersion" in oldEnv ? oldEnv.piVersion : oldEnv.ompVersion) !==
      ("piVersion" in env ? env.piVersion : env.ompVersion)
  )
    environmentChanges.push("image");
  if (env.network !== "none" && oldEnv?.network !== env.network)
    environmentChanges.push("network");
  if (
    env.initialSnapshot &&
    (!oldEnv?.initialSnapshot ||
      Object.entries(env.initialSnapshot).some(
        ([key, value]) =>
          oldEnv.initialSnapshot?.[key as keyof typeof env.initialSnapshot] !==
          value,
      ))
  )
    environmentChanges.push("snapshot");
  if (
    oldEnv &&
    Object.entries(env.resourceLimits).some(
      ([key, value]) =>
        value > oldEnv.resourceLimits[key as keyof typeof env.resourceLimits],
    )
  )
    environmentChanges.push("limits");
  if (
    next.runtimeKind === "omp" &&
    (previous?.runtimeKind !== "omp" ||
      previous.ompConfigChecksum !== next.ompConfigChecksum)
  )
    environmentChanges.push("ompConfig");
  add("environment", "environment", environmentChanges);
  if (next.a2a.inboundEnabled && !previous?.a2a.inboundEnabled)
    add("delegation", "inbound", ["inbound"]);
  if (next.a2a.outboundEnabled && !previous?.a2a.outboundEnabled)
    add("delegation", "outbound", ["outbound"]);
  for (const target of next.a2a.policy.targets) {
    const old = previous?.a2a.policy.targets.find(
      (item) => item.kind === target.kind && item.targetId === target.targetId,
    );
    const limits = [
      "maxCalls",
      "maxDepth",
      "maxConcurrent",
      "timeoutSeconds",
      "maxInputBytes",
    ] as const;
    const budgetExpanded = target.budget
      ? !old?.budget ||
        target.budget.currency !== old.budget.currency ||
        target.budget.maxAuthorizedCostMicros >
          old.budget.maxAuthorizedCostMicros ||
        target.budget.authorizedCostPerCallMicros !==
          old.budget.authorizedCostPerCallMicros
      : Boolean(old?.budget);
    if (!old || limits.some((key) => target[key] > old[key]) || budgetExpanded)
      add(
        "delegation",
        target.targetId,
        target.capabilityIds.length ? target.capabilityIds : [target.targetId],
      );
    else
      add(
        "delegation",
        target.targetId,
        target.capabilityIds.filter((id) => !old.capabilityIds.includes(id)),
      );
  }
  return additions;
}
