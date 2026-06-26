'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getProvider } from '@/lib/agents/queries';
import {
  createAgent,
  updateAgent,
  setAgentTools,
  deleteAgent,
  createProvider,
  deleteProvider,
  setProviderModels,
  createConversation,
} from '@/lib/agents/mutations';
import { modelsEndpoint, modelsHeaders, parseModelList } from '@/lib/agents/models-fetch';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

export type ActionState = { error?: string };

export async function createProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const format = String(formData.get('format') ?? '') === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!name || !baseUrl || !apiKey) return { error: 'Name, base URL and API key are required.' };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };
  try {
    await createProvider(ctx.ws.id, { name, format, baseUrl, apiKey });
  } catch {
    return { error: 'A provider with that name already exists.' };
  }
  revalidatePath(`/app/${slug}/agents`);
  return {};
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
  try {
    const res = await fetch(modelsEndpoint(provider.baseUrl), {
      headers: modelsHeaders(provider.format, provider.apiKey),
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!res.ok) return { error: `Provider returned ${res.status}.` };
    const models = parseModelList(await res.json());
    if (models.length === 0) return { error: 'No models found at that base URL.' };
    await setProviderModels(ctx.ws.id, providerId, models);
  } catch {
    return { error: 'Could not reach the provider base URL.' };
  }
  revalidatePath(`/app/${slug}/agents`);
  return {};
}

export async function createAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'New agent';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const agent = await createAgent(ctx.ws.id, name);
  revalidatePath(`/app/${slug}/agents`);
  redirect(`/app/${slug}/agents/${agent.id}?tab=settings`);
}

export async function deleteAgentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await deleteAgent(ctx.ws.id, agentId);
  revalidatePath(`/app/${slug}/agents`);
  redirect(`/app/${slug}/agents`);
}

export async function updateAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'Not authorized.' };

  const providerId = String(formData.get('providerId') ?? '') || null;
  const model = String(formData.get('model') ?? '') || null;
  const maxStepsRaw = Number(formData.get('maxSteps') ?? AGENT_STEP_BOUNDS.default);
  const maxSteps = Number.isFinite(maxStepsRaw)
    ? Math.min(AGENT_STEP_BOUNDS.max, Math.max(AGENT_STEP_BOUNDS.min, maxStepsRaw))
    : AGENT_STEP_BOUNDS.default;

  await updateAgent(ctx.ws.id, agentId, {
    name: String(formData.get('name') ?? '').trim() || 'New agent',
    systemPrompt: String(formData.get('systemPrompt') ?? '').trim() || null,
    providerId,
    model,
    maxSteps,
  });
  await setAgentTools(ctx.ws.id, agentId, {
    deploymentIds: formData.getAll('deploymentId').map(String),
    installedSkillIds: formData.getAll('installedSkillId').map(String),
    toolkitIds: formData.getAll('toolkitId').map(String),
    subAgentIds: formData.getAll('subAgentId').map(String),
  });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  return {};
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
