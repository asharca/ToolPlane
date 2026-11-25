"use server";
import { actionScope } from "@/lib/workspace/action-scope";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateConsoleConversationTitle } from "@/lib/agents/conversation-naming";
import {
  createConversation,
  renameConsoleConversation,
  deleteConsoleConversation,
} from "@/lib/agents/conversation-mutations";
import type { ActionState } from "./action-state";
import { isManageableAgent } from "./action-access";

export async function createConversationAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;
  const conv = await createConversation(ctx.ws.id, agentId);
  if (!conv) return;
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  redirect(`/app/${slug}/work?agent=${agentId}&c=${conv.id}`);
}

export async function renameConversationAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  const title = String(formData.get("title") ?? "")
    .trim()
    .slice(0, 120);
  if (!conversationId || !title) return;
  const ctx = await actionScope({ slug });
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId))) return;
  if (
    await renameConsoleConversation(ctx.ws.id, agentId, conversationId, title)
  ) {
    revalidatePath(`/app/${slug}/work`);
  }
}

export async function generateConversationTitleAction(
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  const force = formData.get("force") === "1";
  if (!conversationId) return { error: "Conversation not found." };
  const ctx = await actionScope({ slug });
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Conversation not found." };
  try {
    const title = await generateConsoleConversationTitle(
      ctx.ws.id,
      agentId,
      conversationId,
      force,
    );
    if (force && !title)
      return { error: "Could not generate a title for this conversation." };
    revalidatePath(`/app/${slug}/work`);
    return { savedAt: Date.now() };
  } catch {
    return { error: "Could not generate a conversation title." };
  }
}

export async function deleteConversationAction(
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  if (!conversationId) return { error: "Conversation not found." };
  try {
    const ctx = await actionScope({ slug });
    if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
      return { error: "Conversation not found." };
    if (!(await deleteConsoleConversation(ctx.ws.id, agentId, conversationId)))
      return { error: "Conversation not found." };
  } catch {
    return { error: "Could not delete conversation." };
  }
  revalidatePath(`/app/${slug}/work`);
  redirect(`/app/${slug}/work?agent=${agentId}`);
}
