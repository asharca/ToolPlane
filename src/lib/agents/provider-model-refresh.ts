import "server-only";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { providerModelIds } from "@/lib/agents/model";
import { setProviderModels } from "@/lib/agents/mutations";
import {
  fetchProviderModels,
  type ProviderModelFetchConfig,
} from "@/lib/agents/models-fetch";
import { runHermesRuntimeMaintenance } from "@/lib/agents/hermes/runtime";

type HermesRuntimeRef = { agentId: string; sandboxId: string };

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

export async function hermesAgentsUsingProvider(
  workspaceId: string,
  providerId: string,
): Promise<HermesRuntimeRef[]> {
  const agents = await db.agent.findMany({
    where: {
      workspaceId,
      runtime: { is: { kind: "hermes" } },
      modelProviders: { some: { providerId } },
    },
    select: { id: true, runtime: { select: { sandboxId: true } } },
  });
  return agents.flatMap(({ id, runtime }) =>
    runtime ? [{ agentId: id, sandboxId: runtime.sandboxId }] : [],
  );
}

export async function syncHermesAgents(
  workspaceId: string,
  agents: HermesRuntimeRef[],
): Promise<string | null> {
  const errors: string[] = [];
  for (const { agentId, sandboxId } of agents) {
    const result = await runHermesRuntimeMaintenance(
      workspaceId,
      agentId,
      sandboxId,
      { quiesce: false, reprojectAfter: true },
      async () => undefined,
    );
    if (result.status === "error") errors.push(result.error);
  }
  return errors.length ? `Hermes sync failed: ${errors.join("; ")}` : null;
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
  if (builtinModels) {
    await setProviderModels(workspaceId, providerId, builtinModels);
    return null;
  }
  const result = await fetchProviderModels(provider);
  if (!result.ok) return modelFetchError(result);
  await setProviderModels(workspaceId, providerId, result.models);
  return null;
}
