import { db } from "@/lib/db";
import { publishAgentRevision } from "@/lib/agents/revisions";

/** Publish real immutable fixtures without resolving images or starting native runtimes. */
export async function publishFixtureAgentRevision(
  workspaceId: string,
  agentId: string,
) {
  const owner = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { currentRevisionVersion: true },
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
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
  });
}
