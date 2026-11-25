"use server";
import { actionScope } from "@/lib/workspace/action-scope";
import { revalidatePath } from "next/cache";
import { stopSandboxAction } from "@/lib/sandboxes/actions";
import { db } from "@/lib/db";
import type { ActionState } from "./action-state";
import { isManageableAgent } from "./action-access";

export async function stopAgentRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };
  try {
    const sandboxes = await db.sandbox.findMany({
      where: {
        workspaceId: ctx.ws.id,
        OR: [
          { agentLinks: { some: { agentId } } },
          { conversations: { some: { agentId } } },
          { a2aContexts: { some: { agentId, targetKind: "local" } } },
        ],
      },
      select: { id: true },
    });
    // Shared stop tears down persisted MCP bindings without deleting volumes.
    for (const sandbox of sandboxes) {
      const stop = new FormData();
      stop.set("workspace", slug);
      stop.set("sandboxId", sandbox.id);
      await stopSandboxAction(stop);
    }
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    return { savedAt: Date.now() };
  } catch {
    return { error: "Could not stop the Agent runtime." };
  }
}
