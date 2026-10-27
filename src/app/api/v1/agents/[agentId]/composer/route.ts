import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import {
  listComposerItems,
  resolveComposerReference,
  ComposerRequestError,
} from "@/lib/work/composer";
import {
  getMcpPromptSources,
  McpPromptRequestError,
} from "@/lib/process/mcp-prompts";
import {
  AgentSessionRequestError,
  resolveAgentRequestSession,
} from "@/lib/agents/request-session";

export const runtime = "nodejs";
type Params = { params: Promise<{ agentId: string }> };
const scope = {
  conversationId: z.string().min(1).max(240).optional(),
  sandboxId: z.string().min(1).max(240).optional(),
  workSessionId: z.string().min(1).max(240).optional(),
};
const ListSchema = z
  .object({
    ...scope,
    section: z.enum(["references", "skills", "resources", "mcp"]),
    query: z.string().max(200).default(""),
    excludeConversationId: z.string().max(240).optional(),
  })
  .strict();
const ResolveSchema = z
  .object({
    ...scope,
    kind: z.enum(["file", "session", "skill", "resource"]),
    id: z.string().min(1).max(4000),
    deploymentId: z.string().min(1).max(240).optional(),
  })
  .strict();

async function handle(req: Request, { params }: Params) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const liveAgent = await getAgentForRequest((await params).agentId, user.id);
  if (!liveAgent) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    if (req.method === "GET") {
      const input = ListSchema.safeParse(
        Object.fromEntries(new URL(req.url).searchParams),
      );
      if (!input.success)
        return Response.json(
          { error: "Invalid composer request" },
          { status: 400 },
        );
      const { agent, mcpContext } = await resolveAgentRequestSession(
        liveAgent,
        input.data,
      );
      const { section, ...composerInput } = input.data;
      if (section === "mcp") {
        const sources = await getMcpPromptSources(
          agent.workspaceId,
          agent.servers.map((grant) => grant.deploymentId),
        );
        return Response.json({
          items: sources.map((source) => ({
            id: source.deploymentId,
            label: source.serverName,
            status: "available",
          })),
        });
      }
      return Response.json(
        await listComposerItems(
          agent,
          { ...composerInput, section },
          req.signal,
          mcpContext,
        ),
      );
    }
    const input = ResolveSchema.safeParse(await req.json().catch(() => null));
    if (!input.success)
      return Response.json({ error: "Invalid reference" }, { status: 400 });
    const { agent, mcpContext } = await resolveAgentRequestSession(
      liveAgent,
      input.data,
    );
    return Response.json(
      await resolveComposerReference(agent, input.data, req.signal, mcpContext),
    );
  } catch (error) {
    if (
      error instanceof ComposerRequestError ||
      error instanceof McpPromptRequestError ||
      error instanceof AgentSessionRequestError
    )
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Session composer resource is unavailable." },
      { status: 403 },
    );
  }
}
export const GET = handle;
export const POST = handle;
