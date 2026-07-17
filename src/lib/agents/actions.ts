'use server';

import { generateText } from 'ai';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getProvider } from '@/lib/agents/queries';
import { buildModel } from '@/lib/agents/model';
import {
  cloneAgent,
  createAgent,
  updateAgent,
  setAgentTools,
  deleteAgent,
  createProvider,
  updateProvider,
  deleteProvider,
  setProviderModels,
  createConversation,
  setHermesRuntimeEnv,
} from '@/lib/agents/mutations';
import {
  fetchProviderModels,
  type ProviderModelFetchConfig,
} from '@/lib/agents/models-fetch';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  updateAgentChannelConnectionCredentials,
} from '@/lib/agents/channel-connections';
import {
  applyAgentChannelPairing,
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from '@/lib/agents/channel-pairing';
import { getMessagingPlatform, hasBuiltInPairingProvider } from '@/lib/agents/platforms';
import {
  cleanupHermesRuntime,
  stopHermesRuntime,
  syncHermesRuntime,
} from '@/lib/agents/hermes/runtime';
import { parseSandboxEnvText } from '@/lib/sandboxes/env';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

export type ActionState = { error?: string; warning?: string; savedAt?: number };

const PROVIDER_FORMATS = new Set(['openai', 'openai-responses', 'anthropic']);

function modelFetchError(result: Exclude<Awaited<ReturnType<typeof fetchProviderModels>>, { ok: true }>): string {
  if (result.reason === 'status') return `Provider returned ${result.status}.`;
  if (result.reason === 'empty') return 'No models found at that base URL.';
  return 'Could not reach the provider base URL.';
}

async function refreshProviderModels(
  workspaceId: string,
  providerId: string,
  provider: ProviderModelFetchConfig,
): Promise<string | null> {
  const result = await fetchProviderModels(provider);
  if (!result.ok) return modelFetchError(result);
  await setProviderModels(workspaceId, providerId, result.models);
  return null;
}

export async function createProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const requestedFormat = String(formData.get('format') ?? '');
  const format = PROVIDER_FORMATS.has(requestedFormat) ? requestedFormat : 'openai';
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!name || !baseUrl || !apiKey) return { error: 'Name, base URL and API key are required.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  let provider: { id: string };
  try {
    provider = await createProvider(ctx.ws.id, { name, format, baseUrl, apiKey });
  } catch {
    return { error: 'A provider with that name already exists.' };
  }
  const refreshError = await refreshProviderModels(ctx.ws.id, provider.id, { format, baseUrl, apiKey });
  revalidatePath(`/app/${slug}/agents`);
  if (refreshError) {
    return { warning: `Provider added, but models were not refreshed: ${refreshError}`, savedAt: Date.now() };
  }
  return { savedAt: Date.now() };
}

export async function updateProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const requestedFormat = String(formData.get('format') ?? '');
  const format = PROVIDER_FORMATS.has(requestedFormat) ? requestedFormat : 'openai';
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!providerId || !name || !baseUrl) return { error: 'Provider, name and base URL are required.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const existing = await getProvider(ctx.ws.id, providerId);
  if (!existing) return { error: 'Provider not found.' };

  try {
    await updateProvider(ctx.ws.id, providerId, {
      name,
      format,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    });
  } catch {
    return { error: 'A provider with that name already exists.' };
  }

  const shouldRefreshModels = existing.format !== format || existing.baseUrl !== baseUrl || Boolean(apiKey);
  let warning: string | undefined;
  if (shouldRefreshModels) {
    const refreshError = await refreshProviderModels(ctx.ws.id, providerId, {
      format,
      baseUrl,
      apiKey: apiKey || existing.apiKey,
    });
    if (refreshError) warning = `Provider updated, but models were not refreshed: ${refreshError}`;
  }
  revalidatePath(`/app/${slug}/agents`);
  return { ...(warning ? { warning } : {}), savedAt: Date.now() };
}

export async function deleteProviderAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await deleteProvider(ctx.ws.id, providerId);
  revalidatePath(`/app/${slug}/agents`);
}

export async function refreshModelsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const provider = await getProvider(ctx.ws.id, providerId);
  if (!provider) return { error: 'Provider not found.' };
  const refreshError = await refreshProviderModels(ctx.ws.id, providerId, provider);
  if (refreshError) return { error: refreshError };
  revalidatePath(`/app/${slug}/agents`);
  return { savedAt: Date.now() };
}

function sanitizeProviderError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : 'Model test failed.';
  const trimmed = raw.replaceAll(apiKey, '[redacted]').slice(0, 240);
  return trimmed || 'Model test failed.';
}

export async function testProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const modelId = String(formData.get('model') ?? '').trim();
  if (!modelId) return { error: 'Model is required.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const provider = await getProvider(ctx.ws.id, providerId);
  if (!provider) return { error: 'Provider not found.' };

  try {
    await generateText({
      model: buildModel(provider, modelId),
      prompt: 'Reply with exactly: ok',
      maxOutputTokens: 8,
      maxRetries: 0,
      timeout: 10000,
    });
  } catch (error) {
    return { error: sanitizeProviderError(error, provider.apiKey) };
  }
  return { savedAt: Date.now() };
}

export async function createAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'New agent';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const runtime = String(formData.get('runtime') ?? '') === 'hermes' ? 'hermes' : 'native';
  const agent = await createAgent(ctx.ws.id, name, {
    runtime,
    hermesImage: String(formData.get('hermesImage') ?? ''),
  });

  const providerIds = formData.getAll('providerId').map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
  const model = String(formData.get('model') ?? '') || null;
  await updateAgent(ctx.ws.id, agent.id, {
    name,
    systemPrompt: String(formData.get('systemPrompt') ?? '').trim() || null,
    providerId,
    providerIds,
    model,
    maxSteps: AGENT_STEP_BOUNDS.default,
  });
  await setAgentTools(ctx.ws.id, agent.id, {
    deploymentIds: formData.getAll('deploymentId').map(String),
    installedSkillIds: formData.getAll('installedSkillId').map(String),
    toolkitIds: formData.getAll('toolkitId').map(String),
  });
  if (runtime === 'hermes') await syncHermesRuntime(ctx.ws.id, agent.id);
  revalidatePath(`/app/${slug}/agents`);
  redirect(`/app/${slug}/agents/${agent.id}?settings=agent`);
}

export async function deleteAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (!await cleanupHermesRuntime(ctx.ws.id, agentId)) return;
  await deleteAgent(ctx.ws.id, agentId);
  revalidatePath(`/app/${slug}/agents`);
  redirect(`/app/${slug}/agents`);
}

export async function cloneAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sourceAgentId = String(formData.get('agentId') ?? '');
  const requestedName = String(formData.get('cloneName') ?? '').trim().slice(0, 60) || undefined;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sourceAgentId) return;

  const cloned = await cloneAgent(ctx.ws.id, sourceAgentId, requestedName);
  if (!cloned) return;
  if (cloned.runtimeKind === 'hermes') {
    await syncHermesRuntime(ctx.ws.id, cloned.id);
  }
  revalidatePath(`/app/${slug}/agents`);
  redirect(`/app/${slug}/agents/${cloned.id}?settings=agent`);
}

export async function updateAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };

  const providerIds = formData.getAll('providerId').map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
  const model = String(formData.get('model') ?? '') || null;
  const maxStepsRaw = Number(formData.get('maxSteps') ?? AGENT_STEP_BOUNDS.default);
  const maxSteps = Number.isFinite(maxStepsRaw)
    ? Math.min(AGENT_STEP_BOUNDS.max, Math.max(AGENT_STEP_BOUNDS.min, maxStepsRaw))
    : AGENT_STEP_BOUNDS.default;

  await updateAgent(ctx.ws.id, agentId, {
    name: String(formData.get('name') ?? '').trim() || 'New agent',
    systemPrompt: String(formData.get('systemPrompt') ?? '').trim() || null,
    providerId,
    providerIds,
    model,
    maxSteps,
  });
  await setAgentTools(ctx.ws.id, agentId, {
    deploymentIds: formData.getAll('deploymentId').map(String),
    installedSkillIds: formData.getAll('installedSkillId').map(String),
    toolkitIds: formData.getAll('toolkitId').map(String),
    sandboxIds: formData.getAll('sandboxId').map(String),
    subAgentIds: formData.getAll('subAgentId').map(String),
  });
  const runtimeResult = await syncHermesRuntime(ctx.ws.id, agentId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  if (runtimeResult.error) return { error: `Saved, but Hermes sync failed: ${runtimeResult.error}` };
  return { savedAt: Date.now() };
}

export async function syncAgentRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  try {
    const result = await syncHermesRuntime(ctx.ws.id, agentId);
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    if (result.error) return { error: result.error };
    return { savedAt: Date.now() };
  } catch {
    return { error: 'Could not sync the Hermes runtime.' };
  }
}

export async function updateHermesRuntimeEnvAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };

  let env: ReturnType<typeof parseSandboxEnvText>;
  try {
    env = parseSandboxEnvText(formData.get('hermesEnv'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid environment variables.' };
  }

  if (!await setHermesRuntimeEnv(ctx.ws.id, agentId, env)) {
    return { error: 'Hermes runtime not found.' };
  }
  const runtimeResult = await syncHermesRuntime(ctx.ws.id, agentId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  if (runtimeResult.error) return { error: `Saved, but Hermes sync failed: ${runtimeResult.error}` };
  return { savedAt: Date.now() };
}

export async function stopAgentRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  try {
    await stopHermesRuntime(ctx.ws.id, agentId);
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    return { savedAt: Date.now() };
  } catch {
    return { error: 'Could not stop the Hermes runtime.' };
  }
}

export async function createConversationAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const conv = await createConversation(ctx.ws.id, agentId);
  if (!conv) return;
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  redirect(`/app/${slug}/agents/${agentId}?tab=chat&c=${conv.id}`);
}

export async function createAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const platformSlug = String(formData.get('platform') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(formData.get(`credential:${credential.name}`) ?? '').trim();
    if (value) credentials[credential.name] = value;
  }

  const result = await createAgentChannelConnection({
    workspaceId: ctx.ws.id,
    agentId,
    platform: platform.slug,
    name: String(formData.get('name') ?? '').trim() || platform.label,
    credentials,
  });
  if (result.connection && hasBuiltInPairingProvider(platform) && result.connection.missingStartCredentialNames.length > 0) {
    await requestAgentChannelPairing(ctx.ws.id, result.connection.id);
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function updateAgentChannelConnectionCredentialsAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const platformSlug = String(formData.get('platform') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(formData.get(`credential:${credential.name}`) ?? '').trim();
    if (value) credentials[credential.name] = value;
  }

  await updateAgentChannelConnectionCredentials({
    workspaceId: ctx.ws.id,
    connectionId,
    credentials,
  });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function requestAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await requestAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function checkAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await checkAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function applyAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const allowedUserIds = String(formData.get('allowedUserIds') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await applyAgentChannelPairing(ctx.ws.id, connectionId, allowedUserIds);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function deleteAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import('@/lib/agents/channel-runtime');
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  await deleteAgentChannelConnection(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function startAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const { startAgentChannelRunner } = await import('@/lib/agents/channel-runtime');
  await startAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function stopAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const connectionId = String(formData.get('connectionId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import('@/lib/agents/channel-runtime');
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}
