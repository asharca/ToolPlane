import "server-only";
import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { livePort } from "@/lib/process/supervisor";
import { beginAgentConversationSandboxAccess } from "@/lib/sandboxes/activity";

export async function resolveLiveDeployment(
  req: Request,
  deploymentId: string,
) {
  const user = await resolveRequestUser(req);
  if (!user) {
    return {
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }

  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true, workspaceId: true, sandbox: { select: { id: true } } },
  });
  if (!dep) {
    return {
      response: NextResponse.json({ error: "not found" }, { status: 404 }),
    };
  }

  const port = livePort(deploymentId);
  if (!port) {
    return {
      response: NextResponse.json(
        { error: "deployment not running" },
        { status: 503 },
      ),
    };
  }

  return { dep, port, userId: user.id };
}

export async function withDeploymentSandboxAccess(
  sandboxId: string | undefined,
  operation: () => Promise<Response>,
): Promise<Response> {
  if (!sandboxId) return operation();
  let release: () => void;
  try {
    release = beginAgentConversationSandboxAccess(sandboxId);
  } catch {
    return NextResponse.json(
      { error: "Sandbox lifecycle operation is in progress." },
      { status: 503 },
    );
  }
  try {
    const response = await operation();
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      }),
      response,
    );
  } catch (error) {
    release();
    throw error;
  }
}
