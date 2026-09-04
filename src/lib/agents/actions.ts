'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getProvider } from '@/lib/agents/queries';
import { generateConsoleConversationTitle } from '@/lib/agents/conversation-naming';
import { buildModel, providerModelIds } from '@/lib/agents/model';
import { providerPreset } from '@/lib/agents/provider-catalog';
import {
  cloneAgent,
  cloneHermesVolumeData,
  createConfiguredAgent,
  AgentConfigurationError,
  updateAgent,
  setAgentTools,
  createProvider,
  updateProvider,
  updateAgentModelSelection,
  deleteProvider,
  setProviderModels,
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  ProviderModelError,
  createConversation,
  setHermesConversationSelection,
  renameConsoleConversation,
  deleteConsoleConversation,
  setHermesRuntimeEnv,
} from '@/lib/agents/mutations';
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_PRIMARY_TYPES,
  defaultProviderModel,
  inferModelGroup,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
  type ProviderModelValues,
} from '@/lib/agents/model-catalog';
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
  HermesProfileError,
  listHermesProfiles,
  normalizeHermesProfile,
  setHermesProfileDefaultModel,
} from '@/lib/agents/hermes/profiles';
import { prepareHermesConversationSelection } from '@/lib/agents/hermes/conversation-selection';
import {
  copyHermesRuntimeVolume,
  ensureHermesRuntimeReady,
  runHermesRuntimeMaintenance,
  stopHermesRuntime,
  syncHermesRuntime,
  upgradeHermesRuntime,
} from '@/lib/agents/hermes/runtime';
import { parseSandboxEnvText } from '@/lib/sandboxes/env';
import {
  AgentMarketError,
  materializeAgentRelease,
  publishAgentRelease,
  unpublishAgentListing,
  withdrawPendingAgentRelease,
} from '@/lib/agents/market';
import { safeRelativePath } from '@/lib/auth/safe-redirect';
import { implementedAgentRuntimeKind } from '@/lib/agents/runtime-kind';
import { isAgentEndpointRuntimeSandboxConfig } from '@/lib/agents/public-api/tool-policy';
import { db } from '@/lib/db';
import { deleteManagedAgent } from '@/lib/agents/deletion';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

async function isManageableAgent(workspaceId: string, agentId: string): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      publicRuntimeAllocation: { select: { id: true } },
      runtime: { select: { sandbox: { select: { config: true } } } },
    },
  });
  return Boolean(
    agent
    && !agent.publicRuntimeAllocation
    && !isAgentEndpointRuntimeSandboxConfig(agent.runtime?.sandbox.config),
  );
}

export type ActionState = {
  error?: string;
  warning?: string;
  savedAt?: number;
  conversationId?: string;
  created?: boolean;
};

function revalidateProviderViews(slug: string) {
  for (const path of ['agents', 'chat', 'knowledge', 'providers', 'settings', 'settings/providers']) {
    revalidatePath(`/app/${slug}/${path}`);
  }
}

type HermesRuntimeRef = { agentId: string; sandboxId: string };

async function hermesAgentsUsingProvider(
  workspaceId: string,
  providerId: string,
): Promise<HermesRuntimeRef[]> {
  const agents = await db.agent.findMany({
    where: {
      workspaceId,
      runtime: { is: { kind: 'hermes' } },
      modelProviders: { some: { providerId } },
    },
    select: { id: true, runtime: { select: { sandboxId: true } } },
  });
  return agents.flatMap(({ id, runtime }) => (
    runtime ? [{ agentId: id, sandboxId: runtime.sandboxId }] : []
  ));
}

async function syncHermesAgents(workspaceId: string, agents: HermesRuntimeRef[]): Promise<string | null> {
  const errors: string[] = [];
  for (const { agentId, sandboxId } of agents) {
    const result = await runHermesRuntimeMaintenance(
      workspaceId,
      agentId,
      sandboxId,
      { quiesce: false, reprojectAfter: true },
      async () => undefined,
    );
    if (result.status === 'error') errors.push(result.error);
  }
  return errors.length ? `Hermes sync failed: ${errors.join('; ')}` : null;
}

function providerFormValue(format: string, baseUrl: string) {
  const selectedFormat = providerPreset(format) ? format : 'openai';
  return { format: selectedFormat, baseUrl };
}

function cloneOptionsFromFormData(formData: FormData) {
  // Existing integrations can keep posting the old minimal form. Only forms
  // that opt into the scoped-clone UI override the safe historical defaults.
  if (formData.get('cloneOptions') !== '1') return undefined;
  const checked = (name: string) => formData.get(name) === 'on';
  return {
    copyMcp: checked('copyMcp'),
    copySkills: checked('copySkills'),
    copyToolkits: checked('copyToolkits'),
    copySandboxes: checked('copySandboxes'),
    copySubAgents: checked('copySubAgents'),
    copyConversations: checked('copyConversations'),
    copyHermesEnvironment: checked('copyHermesEnvironment'),
    copyHermesVolume: checked('copyHermesVolume'),
  };
}

function modelFetchError(result: Exclude<Awaited<ReturnType<typeof fetchProviderModels>>, { ok: true }>): string {
  if (result.reason === 'status') return `Provider returned ${result.status}.`;
  if (result.reason === 'empty') return 'No models found at that base URL.';
  return 'Could not reach the provider base URL.';
}

async function refreshProviderModels(
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

export async function createProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const requestedFormat = String(formData.get('format') ?? '');
  const { format, baseUrl } = providerFormValue(
    requestedFormat,
    String(formData.get('baseUrl') ?? '').trim(),
  );
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!name || (!providerPreset(format)?.format.startsWith('pi:') && (!baseUrl || !apiKey))) {
    return { error: 'Name, base URL and API key are required for custom providers.' };
  }
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  let provider: { id: string };
  try {
    provider = await createProvider(ctx.ws.id, { name, format, baseUrl, apiKey });
  } catch {
    return { error: 'A provider with that name already exists.' };
  }
  const refreshError = await refreshProviderModels(ctx.ws.id, provider.id, { name, format, baseUrl, apiKey });
  revalidateProviderViews(slug);
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
  const { format, baseUrl } = providerFormValue(
    requestedFormat,
    String(formData.get('baseUrl') ?? '').trim(),
  );
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!providerId || !name || (!providerPreset(format)?.format.startsWith('pi:') && !baseUrl)) {
    return { error: 'Provider, name and base URL are required for custom providers.' };
  }
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const existing = await getProvider(ctx.ws.id, providerId);
  if (!existing) return { error: 'Provider not found.' };
  const hermesAgents = await hermesAgentsUsingProvider(ctx.ws.id, providerId);

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
      name,
      format,
      baseUrl,
      apiKey: apiKey || existing.apiKey,
    });
    if (refreshError) warning = `Provider updated, but models were not refreshed: ${refreshError}`;
  }
  const syncWarning = await syncHermesAgents(ctx.ws.id, hermesAgents);
  if (syncWarning) warning = [warning, syncWarning].filter(Boolean).join(' ');
  revalidateProviderViews(slug);
  return { ...(warning ? { warning } : {}), savedAt: Date.now() };
}

export async function deleteProviderAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const hermesAgents = await deleteProvider(ctx.ws.id, providerId);
  const warning = await syncHermesAgents(ctx.ws.id, hermesAgents);
  revalidateProviderViews(slug);
  if (warning) throw new Error(warning);
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
  const hermesAgents = await hermesAgentsUsingProvider(ctx.ws.id, providerId);
  const refreshError = await refreshProviderModels(ctx.ws.id, providerId, provider);
  if (refreshError) return { error: refreshError };
  const syncError = await syncHermesAgents(ctx.ws.id, hermesAgents);
  if (syncError) return { warning: syncError, savedAt: Date.now() };
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

function optionalPositiveInteger(formData: FormData, name: string): number | null | undefined {
  const raw = String(formData.get(name) ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined;
}

function selectedValues<T extends string>(formData: FormData, name: string, allowed: readonly T[]): T[] {
  return [...new Set(formData.getAll(name).map(String).filter((value): value is T => allowed.includes(value as T)))];
}

function providerModelValues(formData: FormData, modelId: string): ProviderModelValues | null {
  const primaryTypeValue = String(formData.get('primaryType') ?? 'text');
  if (!MODEL_PRIMARY_TYPES.includes(primaryTypeValue as ModelPrimaryType)) return null;
  const contextWindow = optionalPositiveInteger(formData, 'contextWindow');
  const maxInputTokens = optionalPositiveInteger(formData, 'maxInputTokens');
  const maxOutputTokens = optionalPositiveInteger(formData, 'maxOutputTokens');
  if ([contextWindow, maxInputTokens, maxOutputTokens].includes(undefined)) return null;
  const defaults = defaultProviderModel(modelId);
  const name = String(formData.get('name') ?? '').trim();
  const group = String(formData.get('group') ?? '').trim();
  if (name.length > 200 || group.length > 120) return null;
  return {
    ...defaults,
    name: name || modelId,
    group: group || inferModelGroup(modelId),
    primaryType: primaryTypeValue as ModelPrimaryType,
    capabilities: selectedValues<ModelCapability>(formData, 'capabilities', MODEL_CAPABILITIES),
    inputModalities: selectedValues<ModelInputModality>(formData, 'inputModalities', MODEL_INPUT_MODALITIES),
    contextWindow: contextWindow ?? null,
    maxInputTokens: maxInputTokens ?? null,
    maxOutputTokens: maxOutputTokens ?? null,
  };
}

function providerModelError(error: unknown): ActionState {
  return {
    error: error instanceof ProviderModelError ? error.message : 'Could not save the model.',
  };
}

export async function addProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const rawModelIds = String(formData.get('modelId') ?? '').trim().replaceAll('，', ',');
  const modelIds = rawModelIds.split(',').map((modelId) => modelId.trim()).filter(Boolean);
  if (!providerId || !modelIds.length || modelIds.length > 50
    || modelIds.some((modelId) => modelId.length > 200)) {
    return { error: 'Enter between 1 and 50 valid model IDs.' };
  }
  const base = providerModelValues(formData, modelIds[0]!);
  if (!base) return { error: 'Check the model classification and token limits.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const models = modelIds.length === 1
    ? [base]
    : modelIds.map((modelId) => ({
        ...base,
        ...defaultProviderModel(modelId),
        primaryType: base.primaryType,
        capabilities: base.capabilities,
        inputModalities: base.inputModalities,
      }));
  try {
    await addProviderModels(ctx.ws.id, providerId, models);
  } catch (error) {
    return providerModelError(error);
  }
  const syncError = await syncHermesAgents(
    ctx.ws.id,
    await hermesAgentsUsingProvider(ctx.ws.id, providerId),
  );
  if (syncError) return { warning: syncError, savedAt: Date.now() };
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

export async function updateProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const modelId = String(formData.get('modelId') ?? '').trim();
  const model = providerModelValues(formData, modelId);
  if (!providerId || !modelId || modelId.length > 200 || !model) {
    return { error: 'Check the model fields and token limits.' };
  }
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  try {
    await updateProviderModel(ctx.ws.id, providerId, model);
  } catch (error) {
    return providerModelError(error);
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

export async function deleteProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const modelId = String(formData.get('modelId') ?? '').trim();
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const hermesAgents = await hermesAgentsUsingProvider(ctx.ws.id, providerId);
  try {
    await deleteProviderModel(ctx.ws.id, providerId, modelId);
  } catch (error) {
    return providerModelError(error);
  }
  const syncError = await syncHermesAgents(ctx.ws.id, hermesAgents);
  if (syncError) return { warning: syncError, savedAt: Date.now() };
  revalidateProviderViews(slug);
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
    const { models, model } = buildModel(provider, modelId);
    const result = await models.completeSimple(model, {
      messages: [{ role: 'user', content: 'Reply with exactly: ok', timestamp: Date.now() }],
    }, {
      maxTokens: 8,
      maxRetries: 0,
      timeoutMs: 10000,
    });
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      throw new Error(result.errorMessage || 'Model test failed.');
    }
  } catch (error) {
    return { error: sanitizeProviderError(error, provider.apiKey) };
  }
  return { savedAt: Date.now() };
}

export async function updateWorkspaceModelPreferenceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const preference = String(formData.get('preference') ?? '');
  const providerId = String(formData.get('providerId') ?? '');
  const model = String(formData.get('model') ?? '').trim();
  if (preference !== 'default' && preference !== 'title') return { error: 'Invalid model preference.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };

  if (providerId || model) {
    const provider = providerId ? await getProvider(ctx.ws.id, providerId) : null;
    if (!provider || !model || !provider.models.includes(model)) {
      return { error: 'Choose an available model.' };
    }
  }

  await db.workspace.update({
    where: { id: ctx.ws.id },
    data: preference === 'default'
      ? { defaultModelProviderId: providerId || null, defaultModel: model || null }
      : { titleModelProviderId: providerId || null, titleModel: model || null },
  });
  revalidatePath(`/app/${slug}/settings`);
  revalidatePath(`/app/${slug}/agents`);
  return { savedAt: Date.now() };
}

export async function createAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'New agent';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const runtime = implementedAgentRuntimeKind(formData.get('runtime'));
  if (!runtime) throw new Error('Choose an available Agent runtime.');
  const providerIds = formData.getAll('providerId').map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
  const model = String(formData.get('model') ?? '') || null;
  const agent = await createConfiguredAgent(
    ctx.ws.id,
    {
      name,
      systemPrompt: String(formData.get('systemPrompt') ?? '').trim() || null,
      providerId,
      providerIds,
      model,
      maxSteps: AGENT_STEP_BOUNDS.default,
    },
    {
      deploymentIds: formData.getAll('deploymentId').map(String),
      installedSkillIds: formData.getAll('installedSkillId').map(String),
      toolkitIds: formData.getAll('toolkitId').map(String),
      sandboxIds: formData.getAll('sandboxId').map(String),
    },
    {
      runtime,
      hermesImage: String(formData.get('hermesImage') ?? ''),
    },
  );
  if (runtime === 'hermes') await syncHermesRuntime(ctx.ws.id, agent.id);
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  const returnTo = safeRelativePath(formData.get('returnTo'));
  const query = new URLSearchParams({ settings: 'agent' });
  if (returnTo) query.set('returnTo', returnTo);
  redirect(`/app/${slug}/agents/${agent.id}?${query}`);
}

export async function deleteAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;
  if (!await deleteManagedAgent({
    workspaceId: ctx.ws.id,
    agentId,
    actorId: ctx.user.id,
  })) return;
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(`/app/${slug}/sandboxes`);
  redirect(safeRelativePath(formData.get('returnTo')) ?? `/app/${slug}/agents`);
}

export async function uninstallAgentMarketCopyAction(formData: FormData) {
  return deleteAgentAction(formData);
}

export async function cloneAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sourceAgentId = String(formData.get('agentId') ?? '');
  const requestedName = String(formData.get('cloneName') ?? '').trim().slice(0, 60) || undefined;
  const cloneOptions = cloneOptionsFromFormData(formData);
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sourceAgentId) return;
  if (!await isManageableAgent(ctx.ws.id, sourceAgentId)) return;

  const cloned = await cloneAgent(ctx.ws.id, sourceAgentId, requestedName, cloneOptions);
  if (!cloned) return;
  const targetPath = `/app/${slug}/agents/${cloned.id}`;
  if (cloned.runtimeKind === 'hermes') {
    if (cloneOptions?.copyHermesVolume) {
      const copied = await copyHermesRuntimeVolume(
        ctx.ws.id,
        sourceAgentId,
        cloned.id,
        () => cloneHermesVolumeData(ctx.ws.id, sourceAgentId, cloned.id),
      );
      if (copied.status === 'error') {
        revalidatePath(`/app/${slug}/agents`);
        revalidatePath(`/app/${slug}/work`);
        revalidatePath(targetPath);
        redirect(`${targetPath}?settings=agent`);
      }
    }
    await syncHermesRuntime(ctx.ws.id, cloned.id);
  }
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(targetPath);
  redirect(`${targetPath}?settings=agent`);
}

function marketTags(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value
    .split(',')
    .map((tag) => tag.trim().slice(0, 32))
    .filter(Boolean))]
    .slice(0, 6);
}

function marketErrorCode(error: unknown) {
  return error instanceof AgentMarketError ? error.code : 'install_failed';
}

export async function publishAgentReleaseAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;

  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  if (ctx.ws.ownerId !== ctx.user.id) {
    redirect(`${publishPath}?error=owner_only`);
  }
  if (formData.get('confirmPublicContents') !== 'yes') {
    redirect(`${publishPath}?error=confirm_required`);
  }

  const name = String(formData.get('name') ?? '').trim().slice(0, 80);
  const summary = String(formData.get('summary') ?? '').trim().slice(0, 360);
  if (!name || !summary) {
    redirect(`${publishPath}?error=missing_fields`);
  }

  let errorCode: string | null = null;
  try {
    await publishAgentRelease({
      workspaceId: ctx.ws.id,
      agentId,
      publishedById: ctx.user.id,
      listing: {
        slug: String(formData.get('listingSlug') ?? '').trim() || undefined,
        name,
        summary,
        iconUrl: String(formData.get('iconUrl') ?? '').trim().slice(0, 2000) || null,
        tags: marketTags(formData.get('tags')),
        categoryIds: formData.getAll('categoryIds').map(String).filter(Boolean),
      },
    });
  } catch (error) {
    errorCode = marketErrorCode(error);
  }
  if (errorCode) redirect(`${publishPath}?error=${encodeURIComponent(errorCode)}`);

  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?submitted=1`);
}

export async function unpublishAgentListingAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId || ctx.ws.ownerId !== ctx.user.id) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;

  await unpublishAgentListing({
    workspaceId: ctx.ws.id,
    agentId,
    actorId: ctx.user.id,
  });
  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?unpublished=1`);
}

export async function withdrawPendingAgentReleaseAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId || ctx.ws.ownerId !== ctx.user.id) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;

  await withdrawPendingAgentRelease({
    workspaceId: ctx.ws.id,
    agentId,
    actorId: ctx.user.id,
  });
  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?withdrawn=1`);
}

export async function installAgentFromMarketAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const releaseId = String(formData.get('releaseId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').slice(0, 128);
  const returnTo = safeRelativePath(formData.get('returnTo'))
    ?? (workspaceSlug ? `/app/${workspaceSlug}/market/agents` : '/app');
  const ctx = await authorizedWorkspace(workspaceSlug);
  if (!ctx || !releaseId || !idempotencyKey) return;

  let clonedAgentId: string | null = null;
  let errorCode: string | null = null;
  try {
    const result = await materializeAgentRelease({
      releaseId,
      targetWorkspaceId: ctx.ws.id,
      installedById: ctx.user.id,
      idempotencyKey,
      name: String(formData.get('name') ?? '').trim().slice(0, 80) || undefined,
    });
    clonedAgentId = result.agent.id;
    await syncHermesRuntime(ctx.ws.id, clonedAgentId);
  } catch (error) {
    errorCode = marketErrorCode(error);
  }
  if (errorCode) {
    const separator = returnTo.includes('?') ? '&' : '?';
    redirect(`${returnTo}${separator}cloneError=${encodeURIComponent(errorCode)}`);
  }
  if (!clonedAgentId) return;

  revalidatePath(`/app/${workspaceSlug}/agents`);
  revalidatePath(`/app/${workspaceSlug}/market/agents`);
  redirect(`/app/${workspaceSlug}/agents/${clonedAgentId}?settings=agent&from=market`);
}

export async function updateAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };

  const providerIds = formData.getAll('providerId').map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
  const model = String(formData.get('model') ?? '') || null;
  const maxStepsRaw = Number(formData.get('maxSteps') ?? AGENT_STEP_BOUNDS.default);
  const maxSteps = Number.isFinite(maxStepsRaw)
    ? Math.min(AGENT_STEP_BOUNDS.max, Math.max(AGENT_STEP_BOUNDS.min, maxStepsRaw))
    : AGENT_STEP_BOUNDS.default;

  try {
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
      defaultSandboxId: String(formData.get('defaultSandboxId') ?? '') || null,
      subAgentIds: formData.getAll('subAgentId').map(String),
    });
  } catch (error) {
    if (error instanceof AgentConfigurationError) return { error: error.message };
    throw error;
  }
  const runtimeResult = await syncHermesRuntime(ctx.ws.id, agentId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  if (runtimeResult.error) {
    return { warning: `Saved, but Hermes sync failed: ${runtimeResult.error}`, savedAt: Date.now() };
  }
  return { savedAt: Date.now() };
}

export async function updateAgentModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };

  let runtimeKind: string | null | undefined;
  try {
    runtimeKind = await updateAgentModelSelection(
      ctx.ws.id,
      agentId,
      formData.getAll('providerId').map(String),
      String(formData.get('model') ?? '').trim() || null,
    );
  } catch (error) {
    if (error instanceof AgentConfigurationError) return { error: error.message };
    throw error;
  }
  const runtimeResult = runtimeKind === 'hermes'
    ? await syncHermesRuntime(ctx.ws.id, agentId)
    : null;
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/chat`);
  revalidatePath(`/app/${slug}/work`);
  if (runtimeResult?.error) {
    return { warning: `Saved, but Hermes sync failed: ${runtimeResult.error}`, savedAt: Date.now() };
  }
  return { savedAt: Date.now() };
}

async function manageableHermesAgent(workspaceId: string, agentId: string) {
  if (!await isManageableAgent(workspaceId, agentId)) return null;
  return db.agent.findFirst({
    where: { id: agentId, workspaceId, runtime: { is: { kind: 'hermes' } } },
    select: {
      id: true,
      workspaceId: true,
      runtime: { select: { id: true, kind: true, sandboxId: true } },
    },
  });
}

export async function updateHermesConversationSelectionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const conversationId = String(formData.get('conversationId') ?? '').trim() || null;
  const profile = normalizeHermesProfile(formData.get('profile'));
  const useDefault = formData.get('useDefault') === '1';
  const provider = useDefault ? null : String(formData.get('provider') ?? '').trim() || null;
  const model = useDefault ? null : String(formData.get('model') ?? '').trim() || null;
  if (!profile || (provider === null) !== (model === null)) {
    return { error: 'Choose a valid Hermes profile and model.' };
  }
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const agent = await manageableHermesAgent(ctx.ws.id, agentId);
  if (!agent) return { error: 'Hermes agent not found.' };

  try {
    const selection = await prepareHermesConversationSelection(agent, { profile, provider, model });
    const update = await runHermesRuntimeMaintenance(
      ctx.ws.id,
      agent.id,
      agent.runtime!.sandboxId,
      { quiesce: false },
      () => setHermesConversationSelection(
        ctx.ws.id,
        agent.id,
        conversationId,
        selection,
      ),
    );
    if (update.status === 'error') return { error: update.error };
    const result = update.data;
    if (!result) return { error: 'Conversation not found or cannot be changed.' };
    revalidatePath(`/app/${slug}/chat`);
    revalidatePath(`/app/${slug}/work`);
    return { savedAt: Date.now(), ...result };
  } catch (error) {
    if (error instanceof HermesProfileError || error instanceof AgentConfigurationError) {
      return { error: error.message };
    }
    return { error: 'Could not update the Hermes conversation model.' };
  }
}

export async function updateHermesProfileDefaultModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const profile = normalizeHermesProfile(formData.get('profile'));
  const provider = String(formData.get('provider') ?? '').trim();
  const model = String(formData.get('model') ?? '').trim();
  if (!profile || !provider || !model) return { error: 'Choose a valid Hermes profile and model.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const agent = await manageableHermesAgent(ctx.ws.id, agentId);
  if (!agent) return { error: 'Hermes agent not found.' };

  try {
    const profiles = await listHermesProfiles(agent);
    if (!profiles.some((item) => item.name === profile)) {
      return { error: 'The selected Hermes profile no longer exists.' };
    }
    const { provider: projectedProvider } = await prepareHermesConversationSelection(agent, { profile, provider, model });
    if (!projectedProvider) return { error: 'Choose a valid Hermes profile and model.' };
    await setHermesProfileDefaultModel(agent, profile, projectedProvider, model);
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    revalidatePath(`/app/${slug}/chat`);
    return { savedAt: Date.now() };
  } catch (error) {
    if (error instanceof HermesProfileError || error instanceof AgentConfigurationError) {
      return { error: error.message };
    }
    return { error: 'Could not update the Hermes profile model.' };
  }
}

export async function syncAgentRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };
  try {
    const result = await syncHermesRuntime(ctx.ws.id, agentId, { force: true });
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    if (result.error) return { error: result.error };
    if (result.status === 'provisioning') {
      const ready = await ensureHermesRuntimeReady(ctx.ws.id, agentId);
      if (ready.error) return { error: ready.error };
    }
    return { savedAt: Date.now() };
  } catch {
    return { error: 'Could not sync the Hermes runtime.' };
  }
}

export async function upgradeHermesRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const image = String(formData.get('hermesImage') ?? '').trim();
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };
  if (!image) return { error: 'Choose a Hermes image version.' };

  try {
    const result = await upgradeHermesRuntime(ctx.ws.id, agentId, image);
    revalidatePath(`/app/${slug}/agents`);
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    if (result.error) return { error: result.error };
    return { savedAt: Date.now() };
  } catch {
    return { error: 'Could not upgrade the Hermes runtime.' };
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
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };

  let env: ReturnType<typeof parseSandboxEnvText>;
  try {
    env = parseSandboxEnvText(formData.get('hermesEnv'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid environment variables.' };
  }

  if (!await setHermesRuntimeEnv(ctx.ws.id, agentId, env)) {
    return { error: 'Hermes runtime not found.' };
  }
  const runtimeResult = await syncHermesRuntime(ctx.ws.id, agentId, { force: true });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  if (runtimeResult.error) return { error: `Saved, but Hermes sync failed: ${runtimeResult.error}` };
  if (runtimeResult.status === 'provisioning') {
    const ready = await ensureHermesRuntimeReady(ctx.ws.id, agentId);
    if (ready.error) return { error: `Saved, but Hermes sync failed: ${ready.error}` };
  }
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
  if (!await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Agent not found.' };
  try {
    await stopHermesRuntime(ctx.ws.id, agentId);
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    return { savedAt: Date.now() };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Could not stop the Hermes runtime.',
    };
  }
}

export async function createConversationAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;
  const conv = await createConversation(ctx.ws.id, agentId);
  if (!conv) return;
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/chat`);
  redirect(`/app/${slug}/chat?agent=${agentId}&c=${conv.id}`);
}

export async function renameConversationAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const conversationId = String(formData.get('conversationId') ?? '');
  const title = String(formData.get('title') ?? '').trim().slice(0, 120);
  if (!conversationId || !title) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !await isManageableAgent(ctx.ws.id, agentId)) return;
  if (await renameConsoleConversation(ctx.ws.id, agentId, conversationId, title)) {
    revalidatePath(`/app/${slug}/chat`);
  }
}

export async function generateConversationTitleAction(formData: FormData): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const conversationId = String(formData.get('conversationId') ?? '');
  const force = formData.get('force') === '1';
  if (!conversationId) return { error: 'Conversation not found.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !await isManageableAgent(ctx.ws.id, agentId)) return { error: 'Conversation not found.' };
  try {
    const title = await generateConsoleConversationTitle(ctx.ws.id, agentId, conversationId, force);
    if (force && !title) return { error: 'Could not generate a title for this conversation.' };
    revalidatePath(`/app/${slug}/chat`);
    return { savedAt: Date.now() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not generate a conversation title.' };
  }
}

export async function deleteConversationAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const conversationId = String(formData.get('conversationId') ?? '');
  if (!conversationId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !await isManageableAgent(ctx.ws.id, agentId)) return;
  if (!await deleteConsoleConversation(ctx.ws.id, agentId, conversationId)) return;
  revalidatePath(`/app/${slug}/chat`);
  redirect(`/app/${slug}/chat?agent=${agentId}`);
}

export async function createAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const platformSlug = String(formData.get('platform') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (!await isManageableAgent(ctx.ws.id, agentId)) return;
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
