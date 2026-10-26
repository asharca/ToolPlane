"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { abortAgentApiRun } from "@/lib/agents/public-api/run-control";
import { assertPublicEndpointRuntime } from "@/lib/agents/public-api/runtime";
import {
  allowedCorsOrigin,
  normalizedOrigin,
} from "@/lib/agents/public-api/cors";
import {
  createAgentApiKey,
  mintAgentClientToken,
  revokeAgentApiKey,
} from "@/lib/agents/public-api/auth";

export type AgentApiActionState = {
  error?: string;
  success?: boolean;
  savedAt?: string;
  endpointId?: string;
  clientId?: string;
  token?: string;
  expiresAt?: string;
};

type ManagementContext = {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceForUser>>>;
};

async function managementContext(
  slug: string,
): Promise<ManagementContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) return null;
  if (workspace.ownerId === user.id) return { user, workspace };
  const membership = await db.membership.findUnique({
    where: {
      workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
    },
    select: { role: true },
  });
  return membership?.role === "admin" ? { user, workspace } : null;
}

function revalidateAgent(slug: string, agentId: string) {
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function publishAgentEndpointAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await managementContext(slug);
  if (!ctx)
    return {
      error:
        "Only a workspace owner or administrator can publish an Agent API.",
    };
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId: ctx.workspace.id,
      publicRuntimeAllocation: { is: null },
    },
    select: { runtimeKind: true },
  });
  if (!agent) return { error: "Agent not found." };
  try {
    assertPublicEndpointRuntime(agent.runtimeKind);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Public endpoint execution is unsupported.",
    };
  }
  return { error: "No public endpoint execution runtime is available." };
}

export async function setAgentEndpointStatusAction(
  formData: FormData,
): Promise<void> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const publicId = String(formData.get("endpointId") ?? "");
  const status =
    String(formData.get("status") ?? "") === "active" ? "active" : "disabled";
  const ctx = await managementContext(slug);
  if (!ctx) return;
  const endpoint = await db.agentEndpoint.findFirst({
    where: {
      publicId,
      workspaceId: ctx.workspace.id,
      sourceAgentId: agentId,
      ...(status === "active" ? { currentRevisionId: { not: null } } : {}),
    },
    select: { id: true, sourceAgent: { select: { runtimeKind: true } } },
  });
  if (!endpoint) return;
  if (status === "active")
    assertPublicEndpointRuntime(endpoint.sourceAgent.runtimeKind);
  await db.agentEndpoint.update({
    where: { id: endpoint.id },
    data: { status },
  });
  if (status === "disabled") {
    const activeRuns = await db.agentRun.findMany({
      where: {
        endpointId: endpoint.id,
        status: { in: ["provisioning", "running"] },
      },
      select: { id: true, publicId: true },
    });
    await db.agentRun.updateMany({
      where: { id: { in: activeRuns.map((run) => run.id) } },
      data: { cancelRequestedAt: new Date() },
    });
    for (const run of activeRuns) abortAgentApiRun(run.publicId);
  }
  revalidateAgent(slug, agentId);
}

export async function createAgentApiClientAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const publicId = String(formData.get("endpointId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 80) return { error: "Client name is required." };
  const ctx = await managementContext(slug);
  if (!ctx) return { error: "Not authorized." };
  const endpoint = await db.agentEndpoint.findFirst({
    where: { publicId, workspaceId: ctx.workspace.id, sourceAgentId: agentId },
    select: {
      id: true,
      rpmLimit: true,
      dailyRequestLimit: true,
      dailyOutputCharacterLimit: true,
      maxConcurrent: true,
      maxStoredCharacters: true,
    },
  });
  if (!endpoint) return { error: "Endpoint not found." };

  const client = await db.agentApiClient.create({
    data: {
      endpointId: endpoint.id,
      createdById: ctx.user.id,
      name,
      rpmLimit: endpoint.rpmLimit,
      dailyRequestLimit: endpoint.dailyRequestLimit,
      dailyOutputCharacterLimit: endpoint.dailyOutputCharacterLimit,
      maxConcurrent: endpoint.maxConcurrent,
      maxStoredCharacters: endpoint.maxStoredCharacters,
    },
    select: { id: true },
  });
  const key = await createAgentApiKey({
    actorId: ctx.user.id,
    clientId: client.id,
    endpointPublicId: publicId,
    workspaceId: ctx.workspace.id,
    sourceAgentId: agentId,
    name: "Default",
  });
  revalidateAgent(slug, agentId);
  return {
    success: true,
    savedAt: new Date().toISOString(),
    clientId: client.id,
    token: key.token,
  };
}

export async function revokeAgentApiKeyAction(
  formData: FormData,
): Promise<void> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const publicId = String(formData.get("endpointId") ?? "");
  const keyId = String(formData.get("keyId") ?? "");
  const ctx = await managementContext(slug);
  if (!ctx) return;
  await revokeAgentApiKey({
    actorId: ctx.user.id,
    keyId,
    endpointPublicId: publicId,
    workspaceId: ctx.workspace.id,
    sourceAgentId: agentId,
  });
  revalidateAgent(slug, agentId);
}

export async function createAgentApiKeyAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const publicId = String(formData.get("endpointId") ?? "");
  const clientId = String(formData.get("clientId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!clientId || !name || name.length > 80)
    return { error: "Key name is required." };
  const ctx = await managementContext(slug);
  if (!ctx) return { error: "Not authorized." };
  const client = await db.agentApiClient.findFirst({
    where: {
      id: clientId,
      status: "active",
      endpoint: {
        publicId,
        workspaceId: ctx.workspace.id,
        sourceAgentId: agentId,
      },
    },
    select: { id: true },
  });
  if (!client) return { error: "API client not found." };
  try {
    const key = await createAgentApiKey({
      actorId: ctx.user.id,
      clientId: client.id,
      endpointPublicId: publicId,
      workspaceId: ctx.workspace.id,
      sourceAgentId: agentId,
      name,
    });
    revalidateAgent(slug, agentId);
    return {
      success: true,
      savedAt: new Date().toISOString(),
      clientId,
      token: key.token,
    };
  } catch {
    return { error: "The API key could not be created." };
  }
}

export async function createAgentClientTokenAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const publicId = String(formData.get("endpointId") ?? "");
  const clientId = String(formData.get("clientId") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const requestedOrigin = normalizedOrigin(
    String(formData.get("origin") ?? ""),
  );
  if (!clientId || !subject || subject.length > 200 || !requestedOrigin) {
    return {
      error: "Client, subject and an allowed browser origin are required.",
    };
  }
  const ctx = await managementContext(slug);
  if (!ctx) return { error: "Not authorized." };
  const client = await db.agentApiClient.findFirst({
    where: {
      id: clientId,
      status: "active",
      endpoint: {
        publicId,
        workspaceId: ctx.workspace.id,
        sourceAgentId: agentId,
      },
    },
    include: {
      endpoint: { select: { id: true, publicId: true, allowedOrigins: true } },
    },
  });
  if (!client) return { error: "API client not found." };
  if (!allowedCorsOrigin(requestedOrigin, client.endpoint.allowedOrigins)) {
    return {
      error: "The selected browser origin is not allowed by this endpoint.",
    };
  }
  const minted = await mintAgentClientToken({
    endpointId: client.endpoint.id,
    endpointPublicId: client.endpoint.publicId,
    clientId: client.id,
    subject,
    scopes: [
      "responses:create",
      "responses:read",
      "conversations:read",
      "conversations:delete",
    ],
    expiresInSeconds: 15 * 60,
    origin: requestedOrigin,
  });
  return {
    success: true,
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
  };
}
