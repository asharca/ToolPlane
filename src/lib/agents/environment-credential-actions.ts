"use server";

import { actionScope } from "@/lib/workspace/action-scope";

import { db } from "@/lib/db";
import {
  createAgentEnvironmentCredential,
  revokeAgentEnvironmentCredential,
} from "./environment-credentials";
import { AgentRevisionError } from "./revisions";

/** Returns the fixed rule code instead of letting it surface as a server-action failure. */
async function credentialResult<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentRevisionError) return { error: error.code };
    throw error;
  }
}

/** Values are accepted once; list/create/revoke responses never contain plaintext. */
export async function createAgentEnvironmentCredentialAction(
  formData: FormData,
) {
  const user = await actionScope();
  if (!user) return { error: "unauthorized" };
  const ctx = await actionScope({
    slug: String(formData.get("workspace") ?? ""),
    ownerOnly: true,
  });
  if (!ctx) return { error: "forbidden" };
  const { ws: workspace } = ctx;
  return credentialResult(async () => ({
    credential: await createAgentEnvironmentCredential({
      actorUserId: user.id,
      workspaceId: workspace.id,
      agentId: String(formData.get("agentId") ?? ""),
      name: String(formData.get("name") ?? ""),
      value: String(formData.get("value") ?? ""),
    }),
  }));
}

export async function revokeAgentEnvironmentCredentialAction(
  formData: FormData,
) {
  const user = await actionScope();
  if (!user) return { error: "unauthorized" };
  const ctx = await actionScope({
    slug: String(formData.get("workspace") ?? ""),
    ownerOnly: true,
  });
  if (!ctx) return { error: "forbidden" };
  const { ws: workspace } = ctx;
  return credentialResult(() =>
    revokeAgentEnvironmentCredential({
      actorUserId: user.id,
      workspaceId: workspace.id,
      agentId: String(formData.get("agentId") ?? ""),
      credentialId: String(formData.get("credentialId") ?? ""),
    }),
  );
}

export async function listAgentEnvironmentCredentialsAction(
  formData: FormData,
) {
  const user = await actionScope();
  if (!user) return { error: "unauthorized" };
  const ctx = await actionScope({
    slug: String(formData.get("workspace") ?? ""),
    ownerOnly: true,
  });
  if (!ctx) return { error: "forbidden" };
  const { ws: workspace } = ctx;
  const credentials = await db.agentEnvironmentCredential.findMany({
    where: {
      workspaceId: workspace.id,
      agentId: String(formData.get("agentId") ?? ""),
    },
    select: { id: true, name: true, createdAt: true, revokedAt: true },
    orderBy: { createdAt: "asc" },
  });
  return { credentials };
}
