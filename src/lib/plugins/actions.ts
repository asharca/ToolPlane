"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { listPlugins, PluginError, visiblePluginWhere } from "./catalog";
import {
  addPlugin,
  updatePlugin,
  removePlugin,
  pluginMcpBindingsSchema,
} from "./installs";
import {
  createPluginSource,
  updatePluginSource,
  deletePluginSource,
  syncPluginSource,
  GithubRegistryError,
} from "./sources";

export type PluginActionState = { error?: string; success?: boolean };
export type PluginBatchOperation = "update" | "remove";
export type PluginBatchResult = {
  installId: string;
  outcome: "success" | "skipped" | "error";
  message: string;
};

async function context(slug: string) {
  const user = await getCurrentUser();
  if (!user) throw new PluginError("not_authorized", "Sign in required.", 401);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace)
    throw new PluginError("not_authorized", "Workspace access denied.", 403);
  return { user, workspace };
}

export async function pluginUpdateCountAction(slug: string) {
  const { workspace, user } = await context(slug);
  return (await listPlugins(workspace.id, user.id, { installedOnly: true }))
    .updateCount;
}

export async function pluginAction(
  _previous: PluginActionState,
  form: FormData,
): Promise<PluginActionState> {
  const slug = String(form.get("workspace") ?? "");
  try {
    const { workspace, user } = await context(slug);
    const operation = String(form.get("operation") ?? "");
    const id = String(form.get("id") ?? "");
    if (operation === "add" || operation === "update") {
      const bindings = pluginMcpBindingsSchema.parse(
        JSON.parse(String(form.get("mcpBindings") ?? "{}")),
      );
      if (operation === "add")
        await addPlugin(workspace.id, user.id, id, bindings);
      else
        await updatePlugin(
          workspace.id,
          user.id,
          id,
          String(form.get("releaseId") ?? ""),
          bindings,
        );
    } else if (operation === "remove") {
      await removePlugin(workspace.id, user.id, id);
    } else if (operation === "source-add") {
      const visibility =
        form.get("visibility") === "private" ? "private" : "public";
      await createPluginSource(workspace.id, user.id, {
        name: String(form.get("name") ?? ""),
        repository: String(form.get("repository") ?? ""),
        branch: String(form.get("branch") ?? "main"),
        visibility,
        token: String(form.get("token") ?? ""),
      });
    } else if (operation === "source-credentials") {
      await updatePluginSource(workspace.id, user.id, id, {
        token: String(form.get("token") ?? ""),
      });
    } else if (operation === "source-delete") {
      await deletePluginSource(workspace.id, user.id, id);
    } else if (operation === "source-sync") {
      await syncPluginSource(workspace.id, user.id, id);
    } else return { error: "invalid_input" };
    revalidatePath(`/app/${slug}`, "layout");
    return { success: true };
  } catch (error) {
    if (error instanceof PluginError || error instanceof GithubRegistryError)
      return { error: error.code };
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "ZodError")
    )
      return { error: "invalid_input" };
    return { error: "operation_failed" };
  }
}

/** Each install commits independently; one failure never rolls back the rest. */
export async function pluginBatchAction(
  slug: string,
  operation: PluginBatchOperation,
  installIds: string[],
): Promise<PluginBatchResult[]> {
  if (
    typeof slug !== "string" ||
    !slug ||
    slug.length > 200 ||
    (operation !== "update" && operation !== "remove") ||
    !Array.isArray(installIds) ||
    installIds.length === 0 ||
    installIds.length > 100 ||
    installIds.some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id),
    )
  )
    throw new Error("Invalid plugin selection (maximum 100 plugins).");
  const ids = [...new Set(installIds)];
  const ctx = await context(slug).catch(() => null);
  if (!ctx)
    return ids.map((installId) => ({
      installId,
      outcome: "error",
      message: "not_authorized",
    }));
  const { workspace, user } = ctx;
  const installs =
    operation === "update"
      ? new Map(
          (
            await db.marketInstall.findMany({
              where: {
                id: { in: ids },
                targetWorkspaceId: workspace.id,
                status: "ready",
                listing: visiblePluginWhere(workspace.id),
              },
              select: {
                id: true,
                currentReleaseId: true,
                listing: {
                  select: {
                    status: true,
                    releases: {
                      where: { reviewStatus: "approved" },
                      orderBy: { version: "desc" },
                      take: 1,
                      select: { id: true },
                    },
                  },
                },
              },
            })
          ).map((install) => [install.id, install]),
        )
      : null;
  const results: PluginBatchResult[] = [];
  for (const installId of ids) {
    const result = (
      outcome: PluginBatchResult["outcome"],
      message: string,
    ): PluginBatchResult => ({ installId, outcome, message });
    try {
      if (operation === "remove") {
        await removePlugin(workspace.id, user.id, installId);
        results.push(result("success", "removed"));
        continue;
      }
      const install = installs?.get(installId);
      if (!install) {
        results.push(result("error", "not_found"));
        continue;
      }
      const latest = install.listing.releases[0];
      if (install.listing.status !== "published")
        results.push(result("skipped", "unavailable"));
      else if (!latest || latest.id === install.currentReleaseId)
        results.push(result("skipped", "up_to_date"));
      else {
        await updatePlugin(workspace.id, user.id, installId, latest.id);
        results.push(result("success", "updated"));
      }
    } catch (error) {
      results.push(
        result(
          "error",
          error instanceof PluginError ? error.code : "operation_failed",
        ),
      );
    }
  }
  revalidatePath(`/app/${slug}`, "layout");
  return results;
}
