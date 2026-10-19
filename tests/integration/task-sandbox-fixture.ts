import { randomUUID } from "node:crypto";
import type { A2ATask } from "@prisma/client";
import { db } from "@/lib/db";
import type { LocalA2AGrant } from "@/lib/a2a/principal";

const mappings = new Map<
  string,
  { sandboxId: string; conversationId?: string }
>();

/** Persist the already-provisioned runtime at the injected executor boundary. */
export async function mapTaskSandbox(row: A2ATask) {
  const context = await db.a2AContext.findUniqueOrThrow({
    where: { id: row.contextId },
  });
  const grant = row.grant as unknown as LocalA2AGrant;
  const entry = !grant.ancestorTaskIds.length ? grant.entryPolicy : undefined;
  const conversationId =
    entry?.kind === "work"
      ? (
          await db.workSession.findUniqueOrThrow({
            where: { id: entry.sourceId },
          })
        ).conversationId
      : entry?.sourceId;
  const conversation = conversationId
    ? await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })
    : null;
  let sandboxId = context.sandboxId ?? conversation?.sandboxId;
  if (!sandboxId) {
    const source = await db.agentSandbox.findFirstOrThrow({
      where: { agentId: grant.agentId },
      include: { sandbox: true },
    });
    const id = randomUUID();
    const deployment = await db.deployment.create({
      data: {
        workspaceId: grant.workspaceId,
        name: `Mapped ${id}`,
        source: "sandbox",
        status: "running",
        installCfg: {
          sandboxId: id,
          kind: "docker",
          network: source.sandbox.network,
        },
      },
    });
    const sandbox = await db.sandbox.create({
      data: {
        id,
        workspaceId: grant.workspaceId,
        deploymentId: deployment.id,
        name: `Mapped ${id}`,
        slug: `mapped-${id}`,
        kind: "docker",
        network: source.sandbox.network,
        config: {
          managedBy: "agent-conversation",
          agentId: grant.agentId,
          sourceSandboxId: source.sandboxId,
        },
      },
    });
    sandboxId = sandbox.id;
  }
  await db.a2AContext.update({
    where: { id: row.contextId },
    data: { sandboxId },
  });
  if (conversationId)
    await db.conversation.update({
      where: { id: conversationId },
      data: { sandboxId },
    });
  const mapping = { sandboxId, conversationId: conversationId ?? undefined };
  mappings.set(row.contextId, mapping);
  return mapping;
}

export function taskSandbox(row: A2ATask) {
  const mapping = mappings.get(row.contextId);
  if (!mapping) throw new Error("Fixture task sandbox has not been mapped.");
  return mapping;
}

export function assertMappedVolume(
  volumeName: string,
  volumeFor: (id: string) => string,
) {
  if (
    ![...mappings.values()].some(
      ({ sandboxId }) => volumeFor(sandboxId) === volumeName,
    )
  )
    throw new Error("Executor attempted to use an unmapped fixture volume.");
}

export async function assertMappedDeployment(deploymentId: string) {
  const sandbox = await db.sandbox.findUniqueOrThrow({
    where: { deploymentId },
  });
  if (![...mappings.values()].some(({ sandboxId }) => sandboxId === sandbox.id))
    throw new Error("Executor attempted to start an unmapped fixture runtime.");
}
