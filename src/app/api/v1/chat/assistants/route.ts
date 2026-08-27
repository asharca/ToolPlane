import { resolveRequestUser } from '@/lib/auth/request-user';
import { CreateChatAssistantSchema } from '@/lib/chat/schemas';
import {
  ChatServiceError,
  createChatAssistant,
  listChatAssistantsForUser,
} from '@/lib/chat/service';

export const runtime = 'nodejs';

function failure(error: unknown) {
  return error instanceof ChatServiceError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: 'Chat request failed' }, { status: 500 });
}

export async function GET(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const workspaceId = new URL(req.url).searchParams.get('workspaceId')?.trim();
  if (!workspaceId) return Response.json({ error: 'workspaceId is required' }, { status: 400 });
  try {
    return Response.json({ assistants: await listChatAssistantsForUser(user.id, workspaceId) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = CreateChatAssistantSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'Invalid chat assistant' }, { status: 400 });
  try {
    const assistant = await createChatAssistant(user.id, parsed.data);
    return Response.json({ assistant }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
