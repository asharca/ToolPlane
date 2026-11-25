"use server";
import { actionScope } from "@/lib/workspace/action-scope";
import { revalidatePath } from "next/cache";
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  updateAgentChannelConnectionCredentials,
} from "@/lib/agents/channel-connections";
import {
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from "@/lib/agents/channel-pairing";
import {
  getMessagingPlatform,
  hasBuiltInPairingProvider,
} from "@/lib/agents/platforms";
import { isManageableAgent } from "./action-access";

export async function createAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const platformSlug = String(formData.get("platform") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(
      formData.get(`credential:${credential.name}`) ?? "",
    ).trim();
    if (value) credentials[credential.name] = value;
  }

  const result = await createAgentChannelConnection({
    workspaceId: ctx.ws.id,
    agentId,
    platform: platform.slug,
    name: String(formData.get("name") ?? "").trim() || platform.label,
    credentials,
  });
  if (
    result.connection &&
    hasBuiltInPairingProvider(platform) &&
    result.connection.missingStartCredentialNames.length > 0
  ) {
    await requestAgentChannelPairing(ctx.ws.id, result.connection.id);
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function updateAgentChannelConnectionCredentialsAction(
  formData: FormData,
) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const platformSlug = String(formData.get("platform") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(
      formData.get(`credential:${credential.name}`) ?? "",
    ).trim();
    if (value) credentials[credential.name] = value;
  }

  await updateAgentChannelConnectionCredentials({
    workspaceId: ctx.ws.id,
    connectionId,
    credentials,
  });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function requestAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  await requestAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function checkAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  await checkAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function deleteAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  await deleteAgentChannelConnection(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function startAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  const { startAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await startAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function stopAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}
