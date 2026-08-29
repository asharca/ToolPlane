import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { UpdateChatAssistantSchema } from '@/lib/chat/schemas';
import {
  ChatServiceError,
  deleteChatAssistant,
  getChatAssistantForUser,
  updateChatAssistant,
} from '@/lib/chat/service';

export const runtime = 'nodejs';

function failure(error: unknown) {
  return error instanceof ChatServiceError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: 'Chat request failed' }, { status: 500 });
}

export async function GET(req: Request, { params }: { params: Promise<{ assistantId: string }> }) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { assistantId } = await params;
  const assistant = await getChatAssistantForUser(user.id, assistantId);
  return assistant
    ? Response.json({ assistant })
    : Response.json({ error: 'Chat assistant not found' }, { status: 404 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ assistantId: string }> }) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = UpdateChatAssistantSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'Invalid chat assistant' }, { status: 400 });
  try {
    const { assistantId } = await params;
    return Response.json({ assistant: await updateChatAssistant(user.id, assistantId, parsed.data) });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ assistantId: string }> }) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { assistantId } = await params;
    await deleteChatAssistant(user.id, assistantId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
