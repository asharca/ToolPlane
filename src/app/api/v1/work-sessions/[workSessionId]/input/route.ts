import { resolveRequestUser } from '@/lib/auth/request-user';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import {
  appendWorkSessionInput,
  getWorkSessionForUser,
  workSessionWorkingDirectory,
} from '@/lib/work/sessions';
import { kickWorkCoordinator } from '@/lib/work/coordinator';
import { startWorkOutput } from '@/lib/work/run-control';
import { ComposerReferencesSchema } from '@/lib/work/composer-types';
import { acquireConversationOperation, ConversationOperationError } from '@/lib/agents/conversation-operations';
import { parseRuntimeCommand } from '@/lib/agents/runtime-commands';
import { executeRuntimeCommand, RuntimeCommandError } from '@/lib/agents/runtime-command-service';
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
  let body: { input?: unknown; attachmentIds?: unknown; reasoningEffort?: unknown; references?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 20_000) {
    return Response.json({ error: 'Invalid input' }, { status: 400 });
  }
  const references = ComposerReferencesSchema.safeParse(body.references);
  if (!references.success) return Response.json({ error: 'Invalid references' }, { status: 400 });
  const reasoningEffort = body.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(body.reasoningEffort);
  if (body.reasoningEffort !== undefined && !reasoningEffort) {
    return Response.json({ error: 'Invalid reasoningEffort' }, { status: 400 });
  }

  const { workSessionId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work) return Response.json({ error: 'Not found' }, { status: 404 });
  if (parseRuntimeCommand(body.input)) {
    if (references.data.length || (Array.isArray(body.attachmentIds) && body.attachmentIds.length)) return Response.json({ error: 'noAttachments' }, { status: 400 });
    try { return Response.json(await executeRuntimeCommand({ workspaceId: work.workspaceId, agentId: work.agentId, conversationId: work.conversationId, line: body.input, signal: req.signal })); }
    catch (error) {
      if (error instanceof RuntimeCommandError) return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof ConversationOperationError) return Response.json({ error: error.code }, { status: error.status });
      return Response.json({ error: 'failed' }, { status: 502 });
    }
  }
  if (!work.sandbox) return Response.json({ error: 'Work sandbox not found' }, { status: 409 });
  const release = acquireConversationOperation(work.conversationId);
  if (!release) return Response.json({ error: 'This conversation is busy.' }, { status: 409 });
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
      ...(references.data.length ? { references: references.data } : {}),
      ...(attachments.length ? { uploadedById: user.id, attachments } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  } catch (error) {
    return error instanceof WorkAttachmentError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Could not copy attachments into the sandbox' }, { status: 502 });
  } finally { release(); }
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
