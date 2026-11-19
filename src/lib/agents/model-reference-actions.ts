"use server";

import { actionScope } from "@/lib/workspace/action-scope";

import { getProvider } from "@/lib/agents/queries";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";
import type { PiModelReference } from "@/lib/agents/model-catalog";

export async function lookupProviderModelReferencesAction(
  slug: string,
  providerId: string,
  queries: string[],
): Promise<{ matches: PiModelReference[]; error?: string }> {
  if (
    typeof slug !== "string" ||
    !slug ||
    typeof providerId !== "string" ||
    !providerId
  ) {
    return { matches: [], error: "Invalid provider query." };
  }
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return { matches: [], error: "Not authorized." };
  const { ws: workspace } = ctx;
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
