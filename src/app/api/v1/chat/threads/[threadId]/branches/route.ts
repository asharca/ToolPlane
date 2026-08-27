import { resolveRequestUser } from '@/lib/auth/request-user';
import { ChatBranchMutationSchema } from '@/lib/chat/schemas';
import {
  ChatServiceError,
  deleteReservedChatBranch,
  reserveChatBranch,
} from '@/lib/chat/service';

export const runtime = 'nodejs';

function failure(error: unknown) {
  return error instanceof ChatServiceError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: 'Chat branch request failed' }, { status: 500 });
}

async function input(req: Request) {
  try {
    return ChatBranchMutationSchema.safeParse(await req.json());
  } catch {
    return null;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = await input(req);
  if (!parsed?.success) return Response.json({ error: 'Invalid chat branch' }, { status: 400 });
  try {
    const { threadId } = await params;
    return Response.json({ branch: await reserveChatBranch(user.id, threadId, parsed.data.messageId) }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = await input(req);
  if (!parsed?.success) return Response.json({ error: 'Invalid chat branch' }, { status: 400 });
  try {
    const { threadId } = await params;
    return Response.json({ branch: await deleteReservedChatBranch(user.id, threadId, parsed.data.messageId) });
  } catch (error) {
    return failure(error);
  }
}
