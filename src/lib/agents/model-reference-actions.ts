"use server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getProvider } from "@/lib/agents/queries";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";
import type { PiModelReference } from "@/lib/agents/model-catalog";

export async function lookupProviderModelReferencesAction(
  slug: string,
  providerId: string,
  queries: string[],
): Promise<{ matches: PiModelReference[]; error?: string }> {
  const user = await getCurrentUser();
  if (
    typeof slug !== "string" ||
    !slug ||
    typeof providerId !== "string" ||
    !providerId
  ) {
    return { matches: [], error: "Invalid provider query." };
  }
  if (!user) return { matches: [], error: "Not authorized." };
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace || workspace.ownerId !== user.id)
    return { matches: [], error: "Not authorized." };
  const provider = await getProvider(workspace.id, providerId);
  if (!provider) return { matches: [], error: "Provider not found." };
  if (
    !Array.isArray(queries) ||
    queries.length > 51 ||
    queries.some((query) => typeof query !== "string" || query.length > 200)
  ) {
    return { matches: [], error: "Invalid model query." };
  }
  return {
    matches: matchingPiModelReferences(
      provider.format,
      queries,
      provider.baseUrl,
      provider.name,
    ),
  };
}
