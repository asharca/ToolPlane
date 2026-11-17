"use server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
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
  const user = await getCurrentUser();
  if (!user) return { error: "unauthorized" };
  const workspace = await getWorkspaceForUser(
    String(formData.get("workspace") ?? ""),
    user.id,
  );
  if (!workspace || workspace.ownerId !== user.id)
    return { error: "forbidden" };
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
  const user = await getCurrentUser();
  if (!user) return { error: "unauthorized" };
  const workspace = await getWorkspaceForUser(
    String(formData.get("workspace") ?? ""),
    user.id,
  );
  if (!workspace || workspace.ownerId !== user.id)
    return { error: "forbidden" };
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
  const user = await getCurrentUser();
  if (!user) return { error: "unauthorized" };
  const workspace = await getWorkspaceForUser(
    String(formData.get("workspace") ?? ""),
    user.id,
  );
  if (!workspace || workspace.ownerId !== user.id)
    return { error: "forbidden" };
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
