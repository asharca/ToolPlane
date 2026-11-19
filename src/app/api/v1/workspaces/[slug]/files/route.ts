import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import {
  deleteWorkspaceFile,
  type FilePage,
  listWorkspaceFiles,
  parseFileCursor,
  type WorkspaceFileDeletionFailure,
  type WorkspaceFileRef,
} from "@/lib/storage/workspace-files";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };
const route = "/api/v1/workspaces/[slug]/files";
const noStore = { "Cache-Control": "private, no-store" };
const deleteBody = z
  .object({
    files: z
      .array(
        z
          .object({
            kind: z.enum(["attachment", "a2a"]),
            id: z.string().min(1).max(128),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

async function requestScope(req: Request, context: Context) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // The sibling attachment upload endpoint receives a workspace ID here.
  const { slug: id } = await context.params;
  return (
    (await resolveWorkspaceScope({ id }, user.id)) ??
    Response.json({ error: "Workspace not found" }, { status: 404 })
  );
}

function parsePage(params: URLSearchParams): FilePage {
  const kind = params.get("kind") ?? "all";
  const sort = params.get("sort") ?? "size";
  const rawLimit = params.get("limit") ?? "50";
  const limit = Number(rawLimit);
  if (
    (kind !== "all" && kind !== "attachment" && kind !== "a2a") ||
    (sort !== "size" && sort !== "createdAt") ||
    !/^\d+$/.test(rawLimit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error("Invalid pagination parameters");
  }
  const page = { kind, sort, limit } as const;
  const cursor = params.get("cursor");
  return {
    ...page,
    cursor: cursor === null ? null : parseFileCursor(cursor, page),
  };
}

export const GET = withRequestLogging(route, async (req, context: Context) => {
  const scope = await requestScope(req, context);
  if (scope instanceof Response) return scope;
  let page: FilePage;
  try {
    page = parsePage(new URL(req.url).searchParams);
  } catch {
    return Response.json(
      { error: "Invalid pagination parameters" },
      { status: 400 },
    );
  }
  const result = await listWorkspaceFiles(scope, page);
  return result
    ? Response.json(result, { headers: noStore })
    : Response.json({ error: "Workspace not found" }, { status: 404 });
});

export const DELETE = withRequestLogging(
  route,
  async (req, context: Context) => {
    const scope = await requestScope(req, context);
    if (scope instanceof Response) return scope;
    const body = deleteBody.safeParse(await req.json().catch(() => null));
    if (!body.success)
      return Response.json(
        { error: "Expected 1 to 100 file references" },
        { status: 400 },
      );

    const deleted: WorkspaceFileRef[] = [];
    const failed: (WorkspaceFileRef & {
      code: WorkspaceFileDeletionFailure;
    })[] = [];
    for (const file of body.data.files) {
      const code = await deleteWorkspaceFile(scope, file);
      if (code === "deleted") deleted.push(file);
      else failed.push({ ...file, code });
    }
    return Response.json({ deleted, failed }, { headers: noStore });
  },
);
