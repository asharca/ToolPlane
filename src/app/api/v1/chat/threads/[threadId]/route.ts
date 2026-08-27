import { resolveRequestUser } from '@/lib/auth/request-user';
import { UpdateChatThreadSchema } from '@/lib/chat/schemas';
import {
  ChatServiceError,
  deleteChatThread,
  getChatThreadForUser,
  updateChatThread,
} from '@/lib/chat/service';

export const runtime = 'nodejs';

function failure(error: unknown) {
  return error instanceof ChatServiceError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: 'Chat request failed' }, { status: 500 });
}

export async function GET(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { threadId } = await params;
  const thread = await getChatThreadForUser(user.id, threadId);
  return thread
    ? Response.json({ thread })
    : Response.json({ error: 'Chat thread not found' }, { status: 404 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = UpdateChatThreadSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'Invalid chat thread' }, { status: 400 });
  try {
    const { threadId } = await params;
    return Response.json({ thread: await updateChatThread(user.id, threadId, parsed.data) });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { threadId } = await params;
    await deleteChatThread(user.id, threadId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
