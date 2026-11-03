import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { PluginError } from "@/lib/plugins/catalog";
import { GithubRegistryError } from "@/lib/plugins/sources";
import type { z } from "zod";

export async function pluginRequestContext(request: Request, slug: string) {
  const user = await resolveRequestUser(request);
  if (!user) throw new PluginError("unauthorized", "Unauthorized", 401);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace)
    throw new PluginError("not_found", "Workspace not found.", 404);
  return { user, workspace };
}

export async function pluginJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new PluginError("invalid_request", "Invalid JSON request.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new PluginError("invalid_request", parsed.error.message);
  return parsed.data;
}

export function pluginApiError(error: unknown): Response {
  if (error instanceof PluginError || error instanceof GithubRegistryError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  throw error;
}
