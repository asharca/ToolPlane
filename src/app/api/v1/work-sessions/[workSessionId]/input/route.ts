import { resolveRequestUser } from '@/lib/auth/request-user';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import {
  appendWorkSessionInput,
  getWorkSessionForUser,
  workSessionWorkingDirectory,
} from '@/lib/work/sessions';
import { kickWorkCoordinator } from '@/lib/work/coordinator';
import { startWorkOutput } from '@/lib/work/run-control';
import {
  prepareWorkAttachments,
  WorkAttachmentError,
} from '@/lib/attachments/work';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workSessionId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { input?: unknown; attachmentIds?: unknown; reasoningEffort?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 20_000) {
    return Response.json({ error: 'Invalid input' }, { status: 400 });
  }
  const reasoningEffort = body.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(body.reasoningEffort);
  if (body.reasoningEffort !== undefined && !reasoningEffort) {
    return Response.json({ error: 'Invalid reasoningEffort' }, { status: 400 });
  }

  const { workSessionId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!work.sandbox) return Response.json({ error: 'Work sandbox not found' }, { status: 409 });
  let result: Awaited<ReturnType<typeof appendWorkSessionInput>>;
  try {
    const attachments = await prepareWorkAttachments({
      workspaceId: work.workspaceId,
      userId: user.id,
      sandboxId: work.sandbox.id,
      workingDirectory: workSessionWorkingDirectory(work.runtimeSnapshot),
      attachmentIds: body.attachmentIds,
      conversationId: work.conversationId,
    });
    result = await appendWorkSessionInput(work.workspaceId, work.id, body.input, {
      ...(attachments.length ? { uploadedById: user.id, attachments } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  } catch (error) {
    return error instanceof WorkAttachmentError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Could not copy attachments into the sandbox' }, { status: 502 });
  }
  if (!result.ok) {
    return Response.json(
      { error: result.reason === 'invalid_transition' ? `Work is ${result.status}` : 'Invalid input' },
      { status: result.reason === 'not_found' ? 404 : result.reason === 'invalid_input' ? 400 : 409 },
    );
  }
  startWorkOutput(work.id);
  kickWorkCoordinator();
  return Response.json({ status: result.status }, { status: 202 });
}
