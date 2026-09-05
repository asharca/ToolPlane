import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { AgentConfigurationError, type HermesConversationSelection } from '@/lib/agents/mutations';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import { prepareHermesConversationSelection } from '@/lib/agents/hermes/conversation-selection';
import { HermesProfileError } from '@/lib/agents/hermes/profiles';
import { createWorkSession, listWorkSessions, normalizeWorkDirectory } from '@/lib/work/sessions';
import { kickWorkCoordinator } from '@/lib/work/coordinator';
import { startWorkOutput } from '@/lib/work/run-control';
import {
  prepareWorkAttachments,
  WorkAttachmentError,
} from '@/lib/attachments/work';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const agentId = new URL(req.url).searchParams.get('agentId')?.trim();
  if (!agentId) return Response.json({ error: 'agentId is required' }, { status: 400 });
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  return Response.json(await listWorkSessions(agent.workspaceId, agent.id));
}

export async function POST(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: {
    agentId?: unknown;
    sandboxId?: unknown;
    task?: unknown;
    acceptanceCriteria?: unknown;
    workingDirectory?: unknown;
    attachmentIds?: unknown;
    reasoningEffort?: unknown;
    hermesProfile?: unknown;
    hermesProvider?: unknown;
    hermesModel?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
    return Response.json({ error: 'agentId is required' }, { status: 400 });
  }
  if (body.sandboxId !== undefined && typeof body.sandboxId !== 'string') {
    return Response.json({ error: 'Invalid sandboxId' }, { status: 400 });
  }
  if (typeof body.task !== 'string' || !body.task.trim() || body.task.length > 20_000) {
    return Response.json({ error: 'Invalid task' }, { status: 400 });
  }
  if (body.acceptanceCriteria !== undefined && (
    typeof body.acceptanceCriteria !== 'string' || body.acceptanceCriteria.length > 20_000
  )) {
    return Response.json({ error: 'Invalid acceptanceCriteria' }, { status: 400 });
  }
  const reasoningEffort = body.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(body.reasoningEffort);
  if (body.reasoningEffort !== undefined && !reasoningEffort) {
    return Response.json({ error: 'Invalid reasoningEffort' }, { status: 400 });
  }
  const workingDirectory = normalizeWorkDirectory(body.workingDirectory ?? '.');
  if (!workingDirectory) {
    return Response.json({ error: 'Invalid workingDirectory' }, { status: 400 });
  }
  const agent = await getAgentForRequest(body.agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  const hasHermesSelection = body.hermesProfile !== undefined
    || body.hermesProvider !== undefined
    || body.hermesModel !== undefined;
  let requestedHermesSelection: HermesConversationSelection | undefined;
  if (hasHermesSelection) {
    const provider = body.hermesProvider == null
      ? null
      : typeof body.hermesProvider === 'string' ? body.hermesProvider.trim() || null : undefined;
    const model = body.hermesModel == null
      ? null
      : typeof body.hermesModel === 'string' ? body.hermesModel.trim() || null : undefined;
    if (
      agent.runtimeKind !== 'hermes'
      || agent.runtime?.kind !== 'hermes'
      || agent.runtime.sandbox.workspaceId !== agent.workspaceId
      || agent.runtime.sandbox.kind !== 'hermes'
      || agent.runtime.sandbox.network === 'none'
      || (body.sandboxId && body.sandboxId !== agent.runtime.sandboxId)
      || typeof body.hermesProfile !== 'string'
      || provider === undefined
      || model === undefined
      || (provider === null) !== (model === null)
    ) return Response.json({ error: 'Invalid Hermes profile or model' }, { status: 400 });
    requestedHermesSelection = { profile: body.hermesProfile, provider, model };
  }
  if (Array.isArray(body.attachmentIds) && body.attachmentIds.length && !body.sandboxId) {
    return Response.json({ error: 'sandboxId is required for Work attachments' }, { status: 400 });
  }
  let hermesSelection: HermesConversationSelection | undefined;
  if (requestedHermesSelection) {
    try {
      hermesSelection = await prepareHermesConversationSelection(agent, requestedHermesSelection);
    } catch (error) {
      if (error instanceof HermesProfileError || error instanceof AgentConfigurationError) {
        return Response.json({ error: error.message }, {
          status: error instanceof HermesProfileError ? error.status : 400,
        });
      }
      return Response.json({ error: 'Could not prepare the Hermes model' }, { status: 502 });
    }
  }
  let attachments: Awaited<ReturnType<typeof prepareWorkAttachments>>;
  try {
    attachments = await prepareWorkAttachments({
      workspaceId: agent.workspaceId,
      userId: user.id,
      sandboxId: typeof body.sandboxId === 'string' ? body.sandboxId : '',
      workingDirectory,
      attachmentIds: body.attachmentIds,
    });
  } catch (error) {
    return error instanceof WorkAttachmentError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Could not copy attachments into the sandbox' }, { status: 502 });
  }
  let work: Awaited<ReturnType<typeof createWorkSession>>;
  try {
    work = await createWorkSession({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      sandboxId: body.sandboxId,
      task: body.task,
      ...(body.acceptanceCriteria !== undefined ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(hermesSelection ? { hermesSelection } : {}),
      workingDirectory,
      ...(attachments.length ? { uploadedById: user.id, attachments } : {}),
    });
  } catch (error) {
    return error instanceof WorkAttachmentError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Could not create the Work session' }, { status: 502 });
  }
  if (!work) return Response.json({ error: 'Choose a Work-ready Agent with its required sandbox and model providers' }, { status: 400 });
  startWorkOutput(work.id);
  kickWorkCoordinator();
  return Response.json(
    { workSessionId: work.id, conversationId: work.conversationId, status: work.status },
    { status: 202 },
  );
}
