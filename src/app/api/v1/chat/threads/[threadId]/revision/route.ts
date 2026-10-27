import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import {
  ChatServiceError,
  previewChatThreadRevisionUpgrade,
  upgradeChatThreadRevision,
} from "@/lib/chat/service";

export const runtime = "nodejs";

function failure(error: unknown) {
  return error instanceof ChatServiceError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: "Chat request failed" }, { status: 500 });
}

const QuerySchema = z.object({ targetVersion: z.coerce.number().int().min(1) });
const BodySchema = z.object({ targetVersion: z.number().int().min(1) });

/** Preview the field-level diff for upgrading this thread to a target Assistant revision. Does not mutate. */
export const GET = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/revision",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = QuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success)
      return Response.json({ error: "Invalid targetVersion" }, { status: 400 });
    try {
      const { threadId } = await params;
      const diff = await previewChatThreadRevisionUpgrade(
        user.id,
        threadId,
        parsed.data.targetVersion,
      );
      return Response.json({ diff });
    } catch (error) {
      return failure(error);
    }
  },
);

/** Explicitly upgrade this thread's pinned Assistant revision. Blocked while a Run is in progress. */
export const POST = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/revision",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success)
      return Response.json({ error: "Invalid targetVersion" }, { status: 400 });
    try {
      const { threadId } = await params;
      const result = await upgradeChatThreadRevision(
        user.id,
        threadId,
        parsed.data.targetVersion,
      );
      return Response.json(result);
    } catch (error) {
      return failure(error);
    }
  },
);
