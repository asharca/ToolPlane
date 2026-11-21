"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { actionScope } from "@/lib/workspace/action-scope";
import { workspaceScopeWhere } from "@/lib/workspace/scope";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import { trackRuntimeOperation } from "@/lib/runtime/ownership-state";
import { killProcess } from "@/lib/process/supervisor";
import { revokeCredential } from "./oauth/tokens";
import type { McpOAuthActionResult } from "./oauth-types";

export async function disconnectMcpOAuthAction(input: {
  workspace: string;
  deploymentId: string;
}): Promise<McpOAuthActionResult> {
  const ctx = await actionScope({ slug: input.workspace });
  if (!ctx) return { ok: false, error: "notAuthorized" };
  try {
    const result = await runMcpDeploymentOperation(
      ctx.ws.id,
      input.deploymentId,
      () =>
        trackRuntimeOperation(async () => {
          const where = {
            id: input.deploymentId,
            workspace: workspaceScopeWhere(ctx.ws),
            source: "remote",
            installCfg: { path: ["authType"], equals: "oauth" },
          };
          const dep = await db.deployment.findFirst({
            where,
            select: { id: true },
          });
          if (!dep) return false;
          const credential = await db.$transaction(async (tx) => {
            if (
              !(
                await tx.deployment.updateMany({
                  where,
                  data: { status: "setup_required" },
                })
              ).count
            )
              throw new Error();
            await tx.mcpOAuthPending.deleteMany({
              where: { deploymentId: dep.id, workspaceId: ctx.ws.id },
            });
            const credential = await tx.mcpOAuthCredential.findFirst({
              where: { deploymentId: dep.id, workspaceId: ctx.ws.id },
              include: { oauthClient: true },
            });
            if (credential)
              await tx.mcpOAuthCredential.delete({
                where: { id: credential.id },
              });
            return credential;
          });
          await killProcess(dep.id, { finalStatus: "setup_required" });
          if (credential)
            await revokeCredential(credential).catch(() => undefined);
          return true;
        }),
    );
    if (!result.accepted || !result.value)
      return { ok: false, error: "notFound" };
    revalidatePath(`/app/${ctx.ws.slug}/mcp/${input.deploymentId}`);
    return { ok: true };
  } catch {
    return { ok: false, error: "operationFailed" };
  }
}
