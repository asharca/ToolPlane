import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import {
  createWorkSession,
  listWorkSessions,
  normalizeWorkDirectory,
} from "@/lib/work/sessions";
import { kickWorkCoordinator } from "@/lib/work/coordinator";
import { startWorkOutput } from "@/lib/work/run-control";
import { ComposerReferencesSchema } from "@/lib/work/composer-types";
import {
  parseRuntimeCommand,
  runtimeCommands,
} from "@/lib/agents/runtime-commands";
import {
  prepareWorkAttachments,
  WorkAttachmentError,
} from "@/lib/attachments/work";
import { getConversationWorkspaceSandbox } from "@/lib/agents/conversation-workspace";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/work-sessions",
  async function GET(req: Request) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const agentId = new URL(req.url).searchParams.get("agentId")?.trim();
    if (!agentId)
      return Response.json({ error: "agentId is required" }, { status: 400 });
    const agent = await getAgentForRequest(agentId, user.id);
    if (!agent)
      return Response.json({ error: "Agent not found" }, { status: 404 });
    const sessions = await listWorkSessions(agent.workspaceId, agent.id);
    return Response.json(
      await Promise.all(
        sessions.map(async (session) => {
          const bound = await getConversationWorkspaceSandbox({
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            conversationId: session.conversationId,
          });
          const sandbox = bound ?? (session.readOnly ? session.sandbox : null);
          return { ...session, sandboxId: sandbox?.id ?? null, sandbox };
        }),
      ),
    );
  },
);

export const POST = withRequestLogging(
  "/api/v1/work-sessions",
  async function POST(req: Request) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let body: {
      agentId?: unknown;
      sandboxId?: unknown;
      task?: unknown;
      acceptanceCriteria?: unknown;
      workingDirectory?: unknown;
      attachmentIds?: unknown;
      references?: unknown;
      reasoningEffort?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    if (typeof body.agentId !== "string" || !body.agentId.trim()) {
      return Response.json({ error: "agentId is required" }, { status: 400 });
    }
    if (body.sandboxId !== undefined && typeof body.sandboxId !== "string") {
      return Response.json({ error: "Invalid sandboxId" }, { status: 400 });
    }
    if (
      typeof body.task !== "string" ||
      !body.task.trim() ||
      body.task.length > 20_000
    ) {
      return Response.json({ error: "Invalid task" }, { status: 400 });
    }
    const references = ComposerReferencesSchema.safeParse(body.references);
    if (!references.success)
      return Response.json({ error: "Invalid references" }, { status: 400 });
    if (
      body.acceptanceCriteria !== undefined &&
      (typeof body.acceptanceCriteria !== "string" ||
        body.acceptanceCriteria.length > 20_000)
    ) {
      return Response.json(
        { error: "Invalid acceptanceCriteria" },
        { status: 400 },
      );
    }
    const reasoningEffort =
      body.reasoningEffort === undefined
        ? undefined
        : normalizeReasoningEffort(body.reasoningEffort);
    if (body.reasoningEffort !== undefined && !reasoningEffort) {
      return Response.json(
        { error: "Invalid reasoningEffort" },
        { status: 400 },
      );
    }
    const workingDirectory = normalizeWorkDirectory(
      body.workingDirectory ?? ".",
    );
    if (!workingDirectory) {
      return Response.json(
        { error: "Invalid workingDirectory" },
        { status: 400 },
      );
    }
    const agent = await getAgentForRequest(body.agentId, user.id);
    const command = agent
      ? parseRuntimeCommand(body.task, agent.runtimeKind)
      : null;
    if (
      agent &&
      agent.runtimeKind !== "pi-sdk" &&
      command &&
      !runtimeCommands(agent.runtimeKind).some(
        (item) => item.name === command.name,
      )
    )
      return Response.json({ error: "unsupportedCommand" }, { status: 400 });
    if (
      command &&
      (body.task.length > 2000 ||
        references.data.length ||
        (Array.isArray(body.attachmentIds) && body.attachmentIds.length))
    )
      return Response.json(
        { error: "Invalid command input." },
        { status: 400 },
      );
    if (!agent)
      return Response.json({ error: "Agent not found" }, { status: 404 });
    if (agent.runtimeKind !== "pi-sdk" || agent.retiredAt)
      return Response.json(
        { error: "Retired Agent history is read-only." },
        { status: 410 },
      );
    if (
      Array.isArray(body.attachmentIds) &&
      body.attachmentIds.length &&
      !body.sandboxId
    ) {
      return Response.json(
        { error: "sandboxId is required for Work attachments" },
        { status: 400 },
      );
    }
    let attachments: Awaited<ReturnType<typeof prepareWorkAttachments>>;
    try {
      attachments = await prepareWorkAttachments({
        workspaceId: agent.workspaceId,
        userId: user.id,
        sandboxId: typeof body.sandboxId === "string" ? body.sandboxId : "",
        workingDirectory,
        attachmentIds: body.attachmentIds,
      });
    } catch (error) {
      return error instanceof WorkAttachmentError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json(
            { error: "Could not copy attachments into the sandbox" },
            { status: 502 },
          );
    }
    let work: Awaited<ReturnType<typeof createWorkSession>>;
    try {
      work = await createWorkSession({
        a2aActorId: user.id,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        sandboxId: body.sandboxId,
        task: body.task,
        ...(references.data.length ? { references: references.data } : {}),
        ...(body.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: body.acceptanceCriteria }
          : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        workingDirectory,
        ...(attachments.length ? { uploadedById: user.id, attachments } : {}),
      });
    } catch (error) {
      return error instanceof WorkAttachmentError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json(
            { error: "Could not create the Work session" },
            { status: 502 },
          );
    }
    if (!work)
      return Response.json(
        {
          error:
            "Choose a Work-ready Agent with its required sandbox and model providers",
        },
        { status: 400 },
      );
    startWorkOutput(work.id);
    kickWorkCoordinator();
    return Response.json(
      {
        workSessionId: work.id,
        conversationId: work.conversationId,
        status: work.status,
      },
      { status: 202 },
    );
  },
);
