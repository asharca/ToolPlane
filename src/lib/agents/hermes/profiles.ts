import 'server-only';
import {
  acquireHermesRuntimeWriteLease,
  ensureHermesDashboardReady,
  runHermesDashboardMutation,
  syncHermesProfileProjection,
  syncHermesRuntime,
  type HermesRuntimeWriteLease,
} from './runtime';
import { deriveHermesRuntimeToken } from './token';

export const HERMES_DEFAULT_PROFILE = 'default';
export const HERMES_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const HERMES_PROFILE_CHAT_FEATURES = [
  'session_resources',
  'session_chat_streaming',
  'session_model_lock',
] as const;

export type HermesProfileAgent = {
  id: string;
  workspaceId: string;
  runtime: { id: string; kind: string } | null;
};

export type HermesProfile = {
  name: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  description: string;
};

export type HermesProfileProvider = {
  id: string;
  name: string;
  models: string[];
  aliases?: string[];
};

export type HermesProfileModels = {
  profile: string;
  provider: string | null;
  model: string | null;
  providers: HermesProfileProvider[];
};

export class HermesProfileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function normalizeHermesProfile(value: unknown): string | null {
  const profile = String(value ?? '').trim().toLowerCase();
  return HERMES_PROFILE_NAME.test(profile) ? profile : null;
}

function runtimeId(agent: HermesProfileAgent): string {
  if (!agent.runtime || agent.runtime.kind !== 'hermes') {
    throw new HermesProfileError('Hermes runtime is not configured.', 409);
  }
  return agent.runtime.id;
}

function dashboardHeaders(agent: HermesProfileAgent, json = false): HeadersInit {
  return {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-hermes-session-token': deriveHermesRuntimeToken(runtimeId(agent), 'hermes-dashboard-api'),
  };
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { detail?: unknown; error?: unknown } | null;
  return String(body?.detail ?? body?.error ?? `Hermes returned ${response.status}.`).slice(0, 500);
}

async function readDashboardJson(agent: HermesProfileAgent, path: string): Promise<unknown> {
  const ready = await ensureHermesDashboardReady(agent.workspaceId, agent.id);
  if (!ready.port) throw new HermesProfileError(ready.error || 'Hermes dashboard is unavailable.', 503);
  const response = await fetch(`http://127.0.0.1:${ready.port}/hermes-dashboard${path}`, {
    headers: dashboardHeaders(agent),
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new HermesProfileError(await responseMessage(response), response.status);
  return response.json();
}

function optionalString(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

export async function listHermesProfiles(agent: HermesProfileAgent): Promise<HermesProfile[]> {
  const payload = await readDashboardJson(agent, '/api/profiles') as { profiles?: unknown };
  if (!Array.isArray(payload?.profiles)) throw new HermesProfileError('Hermes returned invalid profiles.', 502);
  return payload.profiles.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const name = normalizeHermesProfile(row.name);
    if (!name) return [];
    return [{
      name,
      isDefault: row.is_default === true || name === HERMES_DEFAULT_PROFILE,
      provider: optionalString(row.provider, 128),
      model: optionalString(row.model),
      description: optionalString(row.description, 500) ?? '',
    }];
  });
}

export async function listHermesProfileModels(
  agent: HermesProfileAgent,
  requestedProfile: string,
  writeLease?: HermesRuntimeWriteLease,
): Promise<HermesProfileModels> {
  const profile = normalizeHermesProfile(requestedProfile);
  if (!profile) throw new HermesProfileError('Invalid Hermes profile.');
  await ensureHermesProfileProjection(agent, profile, writeLease);
  const payload = await readDashboardJson(
    agent,
    `/api/model/options?profile=${encodeURIComponent(profile)}&include_unconfigured=false&refresh=false`,
  ) as Record<string, unknown>;
  if (!Array.isArray(payload?.providers)) throw new HermesProfileError('Hermes returned invalid model options.', 502);
  const providers = payload.providers.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (row.authenticated === false || !Array.isArray(row.models)) return [];
    const id = optionalString(row.slug ?? row.id, 128);
    if (!id || /[\u0000-\u001f]/.test(id)) return [];
    const models = row.models.slice(0, 2_000).flatMap((model) => {
      const id = optionalString(typeof model === 'object' && model ? (model as Record<string, unknown>).id : model);
      return id ? [id] : [];
    });
    if (!models.length) return [];
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.flatMap((alias) => optionalString(alias, 128) ?? [])
      : [];
    return [{
      id,
      name: optionalString(row.name ?? row.label, 128) ?? id,
      models,
      ...(aliases.length ? { aliases } : {}),
    }];
  });
  return {
    profile,
    provider: optionalString(payload.provider, 128),
    model: optionalString(payload.model),
    providers,
  };
}

export function hasHermesProfileChatCapabilities(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const features = (value as { features?: unknown }).features;
  if (!features || typeof features !== 'object') return false;
  return HERMES_PROFILE_CHAT_FEATURES.every(
    (feature) => (features as Record<string, unknown>)[feature] === true,
  );
}

export function hasHermesProfileModel(
  options: HermesProfileModels,
  provider: string,
  model: string,
): boolean {
  const bareProvider = provider.replace(/^custom:/, '');
  return options.providers.some((row) => (
    (row.id === provider || row.id === bareProvider || row.aliases?.includes(provider))
    && row.models.includes(model)
  ));
}

async function mutateDashboard(
  agent: HermesProfileAgent,
  path: string,
  body: unknown,
  suppliedLease?: HermesRuntimeWriteLease,
): Promise<void> {
  const lease = suppliedLease ?? acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id);
  if (!lease) throw new HermesProfileError('Hermes runtime maintenance is in progress.', 503);
  try {
    const result = await runHermesDashboardMutation(
      agent.workspaceId,
      agent.id,
      lease,
      async (ready) => {
        if (!ready.port) throw new HermesProfileError(ready.error || 'Hermes dashboard is unavailable.', 503);
        const response = await fetch(`http://127.0.0.1:${ready.port}/hermes-dashboard${path}`, {
          method: 'PUT',
          headers: dashboardHeaders(agent, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          cache: 'no-store',
        });
        if (!response.ok) throw new HermesProfileError(await responseMessage(response), response.status);
        return true;
      },
    );
    if (!result) throw new HermesProfileError('Hermes runtime maintenance is in progress.', 503);
  } finally {
    if (!suppliedLease) lease.release();
  }
}

export async function setHermesProfileDefaultModel(
  agent: HermesProfileAgent,
  profile: string,
  provider: string,
  model: string,
): Promise<void> {
  const normalized = normalizeHermesProfile(profile);
  if (!normalized) throw new HermesProfileError('Invalid Hermes profile.');
  await mutateDashboard(
    agent,
    `/api/profiles/${encodeURIComponent(normalized)}/model`,
    { provider, model },
  );
}

export async function ensureHermesProfileProjection(
  agent: HermesProfileAgent,
  profile: string,
  writeLease?: HermesRuntimeWriteLease,
): Promise<void> {
  const normalized = normalizeHermesProfile(profile);
  if (!normalized) throw new HermesProfileError('Invalid Hermes profile.');
  if (normalized === HERMES_DEFAULT_PROFILE) return;
  const lease = writeLease ?? acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id);
  if (!lease) throw new HermesProfileError('Hermes runtime maintenance is in progress.', 503);
  try {
    if (!await syncHermesProfileProjection(agent.workspaceId, agent.id, normalized, lease)) {
      throw new HermesProfileError('Hermes runtime maintenance is in progress.', 503);
    }
  } finally {
    if (!writeLease) lease.release();
  }
}

export async function supportsHermesProfileChat(agent: HermesProfileAgent): Promise<boolean> {
  let ready = await ensureHermesDashboardReady(agent.workspaceId, agent.id);
  if (!ready.port) throw new HermesProfileError(ready.error || 'Hermes dashboard is unavailable.', 503);
  const probe = (port: number) => fetch(`http://127.0.0.1:${port}/hermes/p/default/v1/capabilities`, {
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  let response: Response;
  try {
    response = await probe(ready.port);
  } catch {
    throw new HermesProfileError('Hermes gateway capability check failed.', 502);
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    const synced = await syncHermesRuntime(agent.workspaceId, agent.id, { force: true });
    if (synced.error) throw new HermesProfileError(synced.error, 503);
    ready = await ensureHermesDashboardReady(agent.workspaceId, agent.id);
    if (!ready.port) throw new HermesProfileError(ready.error || 'Hermes dashboard is unavailable.', 503);
    try {
      response = await probe(ready.port);
    } catch {
      throw new HermesProfileError('Hermes gateway capability check failed.', 502);
    }
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new HermesProfileError(
    response.status === 401 ? 'Hermes gateway authentication is out of sync.' : await responseMessage(response),
    response.status,
  );
  return hasHermesProfileChatCapabilities(await response.json().catch(() => null));
}
