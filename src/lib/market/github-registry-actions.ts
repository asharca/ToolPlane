"use server";

import { revalidatePath, unstable_noStore } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  createGithubResourceRegistry,
  deleteGithubResourceRegistry,
  getGithubResourceRegistryWebhookConfiguration,
  type GithubResourceRegistryWebhookConfiguration,
  GithubRegistryError,
  requestGithubResourceSync,
  updateGithubResourceRegistryCredentials,
} from "./github-registry";
export type GithubResourceRegistryActionState = {
  error?: string;
  success?: string;
};
async function context(formData: FormData) {
  const user = await getCurrentUser();
  const slug = String(formData.get("workspace") ?? "");
  const workspace = user ? await getWorkspaceForUser(slug, user.id) : null;
  if (!user || !workspace) throw new GithubRegistryError("not_authorized");
  return { workspaceId: workspace.id, userId: user.id, slug };
}
function failure(error: unknown): GithubResourceRegistryActionState {
  return {
    error:
      error instanceof GithubRegistryError
        ? error.code
        : "registry_action_failed",
  };
}
function refresh(slug: string) {
  revalidatePath(`/app/${slug}/market`, "layout");
  revalidatePath(`/app/${slug}/pi-packages`);
}
export async function createGithubResourceRegistryAction(
  _previous: GithubResourceRegistryActionState,
  formData: FormData,
): Promise<GithubResourceRegistryActionState> {
  try {
    const ctx = await context(formData);
    await createGithubResourceRegistry({
      ...ctx,
      name: String(formData.get("name") ?? ""),
      repository: String(formData.get("repository") ?? ""),
      branch: String(formData.get("branch") ?? ""),
      visibility: String(formData.get("visibility") ?? "private"),
      token: String(formData.get("token") ?? "") || undefined,
    });
    refresh(ctx.slug);
    return { success: "registry_sync_queued" };
  } catch (error) {
    return failure(error);
  }
}
export async function syncGithubResourceRegistryAction(
  _previous: GithubResourceRegistryActionState,
  formData: FormData,
): Promise<GithubResourceRegistryActionState> {
  try {
    const ctx = await context(formData);
    await requestGithubResourceSync({
      ...ctx,
      registryId: String(formData.get("registryId") ?? ""),
    });
    refresh(ctx.slug);
    return { success: "registry_sync_queued" };
  } catch (error) {
    return failure(error);
  }
}
export async function deleteGithubResourceRegistryAction(
  _previous: GithubResourceRegistryActionState,
  formData: FormData,
): Promise<GithubResourceRegistryActionState> {
  try {
    const ctx = await context(formData);
    await deleteGithubResourceRegistry({
      ...ctx,
      registryId: String(formData.get("registryId") ?? ""),
    });
    refresh(ctx.slug);
    return { success: "registry_removed" };
  } catch (error) {
    return failure(error);
  }
}
export async function updateGithubResourceRegistryCredentialsAction(
  _previous: GithubResourceRegistryActionState,
  formData: FormData,
): Promise<GithubResourceRegistryActionState> {
  try {
    const ctx = await context(formData);
    await updateGithubResourceRegistryCredentials({
      ...ctx,
      registryId: String(formData.get("registryId") ?? ""),
      token: String(formData.get("token") ?? ""),
    });
    refresh(ctx.slug);
    return { success: "registry_sync_queued" };
  } catch (error) {
    return failure(error);
  }
}
export type GithubResourceRegistryWebhookActionState = {
  error?: string;
  webhook?: GithubResourceRegistryWebhookConfiguration;
};
export async function getGithubResourceRegistryWebhookAction(
  _previous: GithubResourceRegistryWebhookActionState,
  formData: FormData,
): Promise<GithubResourceRegistryWebhookActionState> {
  unstable_noStore();
  try {
    const ctx = await context(formData);
    const webhook = await getGithubResourceRegistryWebhookConfiguration({
      ...ctx,
      registryId: String(formData.get("registryId") ?? ""),
    });
    return { webhook };
  } catch (error) {
    return { error: failure(error).error };
  }
}
