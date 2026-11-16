import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "./public-api/body";
import { ORDINARY_AGENT_FILTER } from "./queries";
import {
  AGENT_MEMORY_LIMIT,
  AgentMemoryContent,
  AgentMemoryError,
} from "./memory-inputs";
import {
  retainAgentMemory,
  recallAgentMemories,
  forgetAgentMemory,
} from "./memories";

const input = z
  .object({
    workspace: z.string().min(1).max(240),
    content: AgentMemoryContent,
  })
  .strict();

export async function handleAgentMemories(
  req: Request,
  { params }: { params: Promise<{ agentId: string; memoryId?: string }> },
) {
  const headers = { "Cache-Control": "private, no-store" };
  const user = await resolveRequestUser(req);
  if (!user)
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (
    req.method !== "GET" &&
    !req.headers.has("authorization") &&
    !isSameOriginRequest(req)
  )
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  const parsed =
    req.method === "POST" ? await parseJson(req, input, 16_000) : null;
  if (parsed && !parsed.ok)
    return Response.json(
      { error: "AGENT_MEMORY_INVALID" },
      { status: parsed.reason === "too_large" ? 413 : 400, headers },
    );
  const value = parsed?.ok ? parsed.value : null;
  const url = new URL(req.url);
  const { agentId, memoryId } = await params;
  try {
    const workspace = await getWorkspaceForUser(
      value?.workspace ?? url.searchParams.get("workspace") ?? "",
      user.id,
    );
    if (!workspace)
      return Response.json({ error: "notFound" }, { status: 404, headers });
    const scope = { workspaceId: workspace.id, agentId };
    const result = await db.$transaction(async (tx) => {
      // Management policy matches Agent settings: active workspace owner/member,
      // ordinary Agent only; endpoint-allocated runtimes are never configurable here.
      const agent = await tx.agent.findFirst({
        where: {
          id: agentId,
          workspaceId: workspace.id,
          ...ORDINARY_AGENT_FILTER,
          workspace: {
            status: "active",
            OR: [
              { ownerId: user.id },
              { members: { some: { userId: user.id } } },
            ],
          },
        },
        select: { id: true },
      });
      if (!agent) throw new AgentMemoryError("AGENT_MEMORY_NOT_FOUND");
      if (req.method === "POST" && value)
        return {
          memory: await retainAgentMemory(tx, scope, value.content, {
            creatorType: "user",
          }),
        };
      if (req.method === "DELETE" && memoryId)
        return forgetAgentMemory(tx, scope, memoryId);
      if (req.method !== "GET")
        throw new AgentMemoryError("AGENT_MEMORY_INVALID");
      const query = url.searchParams.get("query");
      const memories = query?.trim()
        ? (await recallAgentMemories(tx, scope, { query, limit: 20 })).memories
        : await tx.agentMemory.findMany({
            where: scope,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: AGENT_MEMORY_LIMIT,
          });
      return {
        memories,
        total: await tx.agentMemory.count({ where: scope }),
        maxMemories: AGENT_MEMORY_LIMIT,
      };
    });
    return Response.json(result, {
      status: req.method === "POST" ? 201 : 200,
      headers,
    });
  } catch (error) {
    if (error instanceof AgentMemoryError) {
      const status =
        error.reason === "AGENT_MEMORY_NOT_FOUND"
          ? 404
          : error.reason === "AGENT_MEMORY_LIMIT_REACHED"
            ? 409
            : 400;
      return Response.json(
        {
          error:
            error.reason === "AGENT_MEMORY_NOT_FOUND"
              ? "notFound"
              : error.reason,
        },
        { status, headers },
      );
    }
    return Response.json(
      { error: "AGENT_MEMORY_FAILED" },
      { status: 500, headers },
    );
  }
}
