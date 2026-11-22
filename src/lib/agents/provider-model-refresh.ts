import "server-only";

import { revalidatePath } from "next/cache";
import { providerModelIds } from "@/lib/agents/model";
import { parseProviderCredential } from "@/lib/agents/provider-credentials";
import { setProviderModels } from "@/lib/agents/provider-mutations";
import {
  fetchProviderModels,
  type ProviderModelFetchConfig,
} from "@/lib/agents/models-fetch";
export function revalidateProviderViews(slug: string) {
  for (const path of [
    "agents",
    "chat",
    "knowledge",
    "providers",
    "settings",
    "settings/providers",
  ]) {
    revalidatePath(`/app/${slug}/${path}`);
  }
}

function modelFetchError(
  result: Exclude<
    Awaited<ReturnType<typeof fetchProviderModels>>,
    { ok: true }
  >,
): string {
  if (result.reason === "status") return `Provider returned ${result.status}.`;
  if (result.reason === "empty") return "No models found at that base URL.";
  return "Could not reach the provider base URL.";
}

export async function refreshProviderModels(
  workspaceId: string,
  providerId: string,
  provider: ProviderModelFetchConfig & { name: string },
): Promise<string | null> {
  const builtinModels = providerModelIds(provider);
  if (builtinModels && (builtinModels.length > 0 || !provider.baseUrl.trim())) {
    await setProviderModels(workspaceId, providerId, builtinModels);
    return null;
  }
  const credential = parseProviderCredential(provider.apiKey);
  const resolvedKey =
    credential?.type === "oauth"
      ? credential.access
      : (credential?.key ?? provider.apiKey);
  const result = await fetchProviderModels({
    ...provider,
    apiKey: resolvedKey,
  });
  if (!result.ok) return modelFetchError(result);
  await setProviderModels(workspaceId, providerId, result.models);
  return null;
}
