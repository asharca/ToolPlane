import { db } from "@/lib/db";
import { publishAgentRevision } from "@/lib/agents/revisions";
import { OMP_VERSION } from "@/lib/agents/omp-config";
import { PI_SDK_VERSION } from "@/lib/agents/pi-version";

/** Publish real immutable fixtures without resolving images or starting native runtimes. */
export async function publishFixtureAgentRevision(
  workspaceId: string,
  agentId: string,
) {
  const owner = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { currentRevisionVersion: true, runtimeKind: true },
  });
  const current = owner.currentRevisionVersion
    ? await db.agentRevision.findUniqueOrThrow({
        where: {
          agentId_version: { agentId, version: owner.currentRevisionVersion },
        },
        select: { id: true },
      })
    : null;
  return publishAgentRevision(workspaceId, agentId, {
    expectedRevisionId: current?.id ?? null,
    environment: {
      kind: "docker",
      image: `fixture@sha256:${"a".repeat(64)}`,
      network: "isolated",
      ...(owner.runtimeKind === "omp"
        ? { ompVersion: OMP_VERSION }
        : { piVersion: PI_SDK_VERSION }),
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
  });
}
