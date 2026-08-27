import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
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
    maxSteps?: unknown;
    workingDirectory?: unknown;
    attachmentIds?: unknown;
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
  if (body.maxSteps !== undefined && (
    typeof body.maxSteps !== 'number' || !Number.isInteger(body.maxSteps)
    || body.maxSteps < 1 || body.maxSteps > 100
  )) {
    return Response.json({ error: 'Invalid maxSteps' }, { status: 400 });
  }
  const workingDirectory = normalizeWorkDirectory(body.workingDirectory ?? '.');
  if (!workingDirectory) {
    return Response.json({ error: 'Invalid workingDirectory' }, { status: 400 });
  }
  const agent = await getAgentForRequest(body.agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (Array.isArray(body.attachmentIds) && body.attachmentIds.length && !body.sandboxId) {
    return Response.json({ error: 'sandboxId is required for Work attachments' }, { status: 400 });
  }
  let work: Awaited<ReturnType<typeof createWorkSession>>;
  try {
    const attachments = await prepareWorkAttachments({
      workspaceId: agent.workspaceId,
      userId: user.id,
      sandboxId: typeof body.sandboxId === 'string' ? body.sandboxId : '',
      workingDirectory,
      attachmentIds: body.attachmentIds,
    });
    work = await createWorkSession({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      sandboxId: body.sandboxId,
      task: body.task,
      ...(body.acceptanceCriteria !== undefined ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
      ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}),
      workingDirectory,
      ...(attachments.length ? { uploadedById: user.id, attachments } : {}),
    });
  } catch (error) {
    return error instanceof WorkAttachmentError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Could not copy attachments into the sandbox' }, { status: 502 });
  }
  if (!work) return Response.json({ error: 'Choose a Work-ready Agent with its required sandbox and model providers' }, { status: 400 });
  startWorkOutput(work.id);
  kickWorkCoordinator();
  return Response.json(
    { workSessionId: work.id, conversationId: work.conversationId, status: work.status },
    { status: 202 },
  );
}
