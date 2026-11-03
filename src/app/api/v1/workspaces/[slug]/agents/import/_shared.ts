import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { isSameOriginRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import {
  OmpImportRequestSchema,
  OMP_IMPORT_MAX_BYTES,
} from "@/lib/agents/omp-import-contract";
import {
  OmpImportError,
  previewOmpImport,
  commitOmpImport,
} from "@/lib/agents/omp-import";
import { PluginError } from "@/lib/plugins/catalog";
import { ZodError } from "zod";

export async function handleOmpImport(
  request: Request,
  slug: string,
  commit: boolean,
) {
  try {
    const user = await resolveRequestUser(request);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!request.headers.has("authorization") && !isSameOriginRequest(request))
      return Response.json({ error: "Forbidden" }, { status: 403 });
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (!workspace)
      return Response.json({ error: "Not found" }, { status: 404 });
    const parsed = await parseJson(
      request,
      OmpImportRequestSchema,
      OMP_IMPORT_MAX_BYTES,
    );
    if (!parsed.ok)
      return Response.json(
        { error: "OMP_IMPORT_INVALID" },
        { status: parsed.reason === "too_large" ? 413 : 400 },
      );
    const scope = { workspaceId: workspace.id, userId: user.id, slug };
    const result = commit
      ? await commitOmpImport(scope, parsed.value)
      : await previewOmpImport(scope, parsed.value);
    return Response.json(result, {
      status: commit ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OmpImportError || error instanceof PluginError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof ZodError)
      return Response.json({ error: "OMP_IMPORT_INVALID" }, { status: 400 });
    // Loader, remote server, and parser errors may contain source bytes or secrets.
    return Response.json(
      { error: "OMP_IMPORT_PREPARATION_FAILED" },
      { status: 422 },
    );
  }
}
