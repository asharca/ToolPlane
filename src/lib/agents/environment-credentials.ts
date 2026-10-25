import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";
import { AgentRevisionError, requireAgentRevision } from "./revisions";
import { writeAudit } from "@/lib/observability/audit";

const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reservedEnvironment =
  /^(?:TOOLPLANE_|TP_|NODE_|LD_|DYLD_|npm_|NPM_|BUN_|AUTH_SECRET$|DATABASE_URL$|DIRECT_URL$|PI_CODING_AGENT_DIR$|PI_PACKAGE_DIR$|HOME$|PATH$|SHELL$|ENV$|BASH_ENV$|PYTHONPATH$)/;

export function assertAgentCredentialName(name: string) {
  if (!environmentName.test(name) || reservedEnvironment.test(name)) {
    throw new AgentRevisionError("AGENT_CREDENTIAL_NAME_INVALID");
  }
}

/** Credentials are explicitly created by the workspace owner, never imported from another subsystem. */
export async function createAgentEnvironmentCredential(input: {
  actorUserId: string;
  workspaceId: string;
  agentId: string;
  name: string;
  value: string;
}) {
  assertAgentCredentialName(input.name);
  if (
    !input.value ||
    input.value.length > 65_536 ||
    input.value.includes("\0")
  ) {
    throw new AgentRevisionError("AGENT_CREDENTIAL_VALUE_INVALID");
  }
  const id = randomUUID();
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: {
        id: input.agentId,
        workspaceId: input.workspaceId,
        runtimeKind: "pi-sdk",
        retiredAt: null,
        workspace: { ownerId: input.actorUserId, status: "active" },
      },
      select: { id: true },
    });
    if (!agent) throw new AgentRevisionError("AGENT_CREDENTIAL_FORBIDDEN");
    const encryptedValue = encryptSecretText(
      JSON.stringify({
        id,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        name: input.name,
        value: input.value,
      }),
    );
    const credential = await tx.agentEnvironmentCredential.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        name: input.name,
        encryptedValue: encryptedValue as Prisma.InputJsonValue,
      },
      select: { id: true, name: true, createdAt: true, revokedAt: true },
    });
    await writeAudit(tx, {
      actorId: input.actorUserId,
      workspaceId: input.workspaceId,
      action: "agent.environment_credential.created",
      targetType: "AgentEnvironmentCredential",
      targetId: id,
      changes: { agentId: input.agentId, name: input.name },
    });
    return credential;
  });
}

export async function revokeAgentEnvironmentCredential(input: {
  actorUserId: string;
  workspaceId: string;
  agentId: string;
  credentialId: string;
}) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: {
        id: input.agentId,
        workspaceId: input.workspaceId,
        workspace: { ownerId: input.actorUserId, status: "active" },
      },
      select: { id: true },
    });
    if (!agent) throw new AgentRevisionError("AGENT_CREDENTIAL_FORBIDDEN");
    const result = await tx.agentEnvironmentCredential.updateMany({
      where: {
        id: input.credentialId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (result.count)
      await writeAudit(tx, {
        actorId: input.actorUserId,
        workspaceId: input.workspaceId,
        action: "agent.environment_credential.revoked",
        targetType: "AgentEnvironmentCredential",
        targetId: input.credentialId,
        changes: { agentId: input.agentId },
      });
    return { revoked: result.count === 1 };
  });
}

/** Publication checks identities only; secret material is not read during native preflight. */
export async function assertAgentEnvironmentCredentialReferences(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  references: readonly { name: string; credentialId: string }[],
) {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const reference of references) {
    assertAgentCredentialName(reference.name);
    if (names.has(reference.name) || ids.has(reference.credentialId)) {
      throw new AgentRevisionError("AGENT_CREDENTIAL_REFERENCE_INVALID");
    }
    names.add(reference.name);
    ids.add(reference.credentialId);
  }
  if (!references.length) return;
  const rows = await tx.agentEnvironmentCredential.findMany({
    where: { id: { in: [...ids] }, workspaceId, agentId, revokedAt: null },
    select: { id: true, name: true },
  });
  if (
    rows.length !== references.length ||
    references.some(
      (ref) =>
        !rows.some(
          (row) => row.id === ref.credentialId && row.name === ref.name,
        ),
    )
  ) {
    throw new AgentRevisionError("AGENT_CREDENTIAL_REVOKED");
  }
}

export type AgentEnvironmentCredentialContext = {
  workspaceId: string;
  agentId: string;
  agentRevisionId: string;
  conversationId?: string;
  contextId?: string;
};

/** Only a persisted, resolved session may decrypt its exact pinned reference allowlist. */
export async function resolveAgentEnvironmentCredentials(
  context: AgentEnvironmentCredentialContext,
) {
  return db.$transaction(async (tx) => {
    if (!context.conversationId && !context.contextId)
      throw new AgentRevisionError("AGENT_SESSION_REQUIRED");
    if (context.conversationId) {
      const conversation = await tx.conversation.findFirst({
        where: {
          id: context.conversationId,
          agentId: context.agentId,
          agentRevisionId: context.agentRevisionId,
          legacyRevisionUnresolved: false,
          agent: { workspaceId: context.workspaceId },
        },
        select: { id: true },
      });
      if (!conversation)
        throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
    }
    if (context.contextId) {
      const taskContext = await tx.a2AContext.findFirst({
        where: {
          id: context.contextId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          targetKind: "local",
          agentRevisionId: context.agentRevisionId,
          legacyRevisionUnresolved: false,
        },
        select: { id: true },
      });
      if (!taskContext)
        throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
    }
    const revision = await requireAgentRevision(
      tx,
      context.agentId,
      context.agentRevisionId,
    );
    const references = revision.config.environment.credentialReferences;
    await assertAgentEnvironmentCredentialReferences(
      tx,
      context.workspaceId,
      context.agentId,
      references,
    );
    if (!references.length) return {};
    // Never select all workspace credentials, even temporarily.
    const rows = await tx.agentEnvironmentCredential.findMany({
      where: {
        id: { in: references.map((ref) => ref.credentialId) },
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        revokedAt: null,
      },
      select: { id: true, name: true, encryptedValue: true },
    });
    if (rows.length !== references.length)
      throw new AgentRevisionError("AGENT_CREDENTIAL_REVOKED");
    const values: Record<string, string> = {};
    for (const row of rows) {
      const payload: unknown = JSON.parse(
        decryptSecretText(row.encryptedValue),
      );
      if (
        !payload ||
        typeof payload !== "object" ||
        !("id" in payload) ||
        payload.id !== row.id ||
        !("workspaceId" in payload) ||
        payload.workspaceId !== context.workspaceId ||
        !("agentId" in payload) ||
        payload.agentId !== context.agentId ||
        !("name" in payload) ||
        payload.name !== row.name ||
        !("value" in payload) ||
        typeof payload.value !== "string"
      ) {
        throw new AgentRevisionError("AGENT_CREDENTIAL_INVALID");
      }
      values[row.name] = payload.value;
    }
    return values;
  });
}
