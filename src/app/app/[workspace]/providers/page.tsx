import type { ModelCost } from "@earendil-works/pi-ai";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { ProvidersPanel } from "@/components/dashboard/agents/ProvidersPanel";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listProviders } from "@/lib/agents/queries";
import { piProviderPresets } from "@/lib/agents/provider-catalog";
import { backfillProviderModels } from "@/lib/agents/mutations";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { getWorkspaceForUser } from "@/lib/workspace/queries";

export const dynamic = "force-dynamic";

export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const locale = await getLocale();
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");

  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");

  const timeZone = resolveUserTimeZone(user);
  await backfillProviderModels(ws.id);
  const providers = await listProviders(ws.id);
  const presets = piProviderPresets();

  return (
    <ProvidersPanel
      slug={slug}
      piProviderPresets={presets}
      providers={providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        format: provider.format,
        baseUrl: provider.baseUrl,
        modelCount: provider.models.length,
        models: provider.models,
        modelRecords: provider.modelRecords.map((model) => ({
          modelId: model.modelId,
          name: model.name,
          group: model.group,
          primaryType: model.primaryType,
          capabilities: model.capabilities,
          inputModalities: model.inputModalities,
          contextWindow: model.contextWindow,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens,
          cost: model.cost as ModelCost | null,
          source: model.source,
        })),
        modelsFetchedAt: provider.modelsFetchedAt
          ? formatInTimeZone(
              provider.modelsFetchedAt,
              timeZone,
              { dateStyle: "medium", timeStyle: "short" },
              locale,
            )
          : null,
      }))}
    />
  );
}
