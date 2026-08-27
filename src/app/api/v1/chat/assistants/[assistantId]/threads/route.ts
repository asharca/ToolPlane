import { resolveRequestUser } from '@/lib/auth/request-user';
import { CreateChatThreadSchema } from '@/lib/chat/schemas';
import { ChatServiceError, createChatThread } from '@/lib/chat/service';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ assistantId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown = {};
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  const parsed = CreateChatThreadSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'Invalid chat thread' }, { status: 400 });
  try {
    const { assistantId } = await params;
    const thread = await createChatThread(user.id, assistantId, parsed.data);
    return Response.json({ thread }, { status: 201 });
  } catch (error) {
    return error instanceof ChatServiceError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Chat request failed' }, { status: 500 });
  }
}
