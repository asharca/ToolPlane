import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { withRequestLogging } from "@/lib/observability/http";
import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/quick-jump",
  async (req: Request, context: { params: Promise<{ slug: string }> }) => {
    const user = await resolveRequestUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { slug } = await context.params;
    const scope = await resolveWorkspaceScope({ slug }, user.id);
    if (!scope) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const workspaceWhere = workspaceScopeWhere(scope);

    const [assistants, threads, agents, sessions, mcpServers, sandboxes] =
      await Promise.all([
        db.chatAssistant.findMany({
          where: { workspace: workspaceWhere },
          select: {
            id: true,
            name: true,
            model: true,
            pinned: true,
            updatedAt: true,
          },
          orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
          take: 12,
        }),
        db.chatThread.findMany({
          where: { workspace: workspaceWhere },
          select: {
            id: true,
            title: true,
            assistantId: true,
            assistant: { select: { name: true } },
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        db.agent.findMany({
          where: { workspace: workspaceWhere, retiredAt: null },
          select: {
            id: true,
            name: true,
            model: true,
            pinned: true,
            currentRevisionVersion: true,
            updatedAt: true,
          },
          orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
          take: 12,
        }),
        db.workSession.findMany({
          where: { workspace: workspaceWhere },
          select: {
            id: true,
            title: true,
            task: true,
            status: true,
            agentId: true,
            agent: { select: { name: true } },
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        db.deployment.findMany({
          where: { workspace: workspaceWhere },
          select: {
            id: true,
            name: true,
            status: true,
            server: { select: { name: true } },
            sandbox: { select: { id: true, name: true } },
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        db.sandbox.findMany({
          where: { workspace: workspaceWhere },
          select: {
            id: true,
            name: true,
            kind: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
      ]);

    return NextResponse.json(
      {
        assistants: assistants.map((assistant) => ({
          id: assistant.id,
          name: assistant.name,
          model: assistant.model,
          pinned: assistant.pinned,
          updatedAt: assistant.updatedAt.toISOString(),
        })),
        threads: threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          assistantId: thread.assistantId,
          assistantName: thread.assistant?.name ?? null,
          updatedAt: thread.updatedAt.toISOString(),
        })),
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          model: agent.model,
          pinned: agent.pinned,
          ready: agent.currentRevisionVersion > 0,
          updatedAt: agent.updatedAt.toISOString(),
        })),
        sessions: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          task: session.task ? session.task.slice(0, 120) : null,
          status: session.status,
          agentId: session.agentId,
          agentName: session.agent?.name ?? null,
          updatedAt: session.updatedAt.toISOString(),
        })),
        mcpServers: mcpServers.map((deployment) => ({
          id: deployment.id,
          name: deployment.name || deployment.server?.name || deployment.id,
          status: deployment.status,
          sandboxName: deployment.sandbox?.name ?? null,
          updatedAt: deployment.updatedAt.toISOString(),
        })),
        sandboxes: sandboxes.map((sandbox) => ({
          id: sandbox.id,
          name: sandbox.name,
          kind: sandbox.kind,
          updatedAt: sandbox.updatedAt.toISOString(),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
