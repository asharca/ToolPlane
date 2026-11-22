import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AuthEvent,
  AuthPrompt,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  builtinProviders,
  radiusProvider,
} from "@earendil-works/pi-ai/providers/all";
import { db } from "@/lib/db";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { piProviderId } from "./provider-catalog";
import { serializeProviderCredential } from "./provider-credentials";
import {
  refreshProviderModels,
  revalidateProviderViews,
} from "./provider-model-refresh";
import { createProvider, updateProvider } from "./provider-mutations";
import type {
  ProviderOAuthDeviceCodeInfo,
  ProviderOAuthInfoNotice,
  ProviderOAuthPrompt,
  ProviderOAuthSessionSnapshot,
  ProviderOAuthUrlInfo,
} from "./provider-oauth-types";

const SESSION_TTL_MS = 10 * 60 * 1000;
const INITIAL_WAIT_TIMEOUT_MS = 5_000;
const INPUT_WAIT_TIMEOUT_MS = 5_000;

export class ProviderOAuthError extends Error {
  constructor(
    public readonly code:
      | "provider_oauth_unsupported"
      | "provider_name_required"
      | "provider_name_taken"
      | "provider_not_found"
      | "session_not_found"
      | "prompt_not_active",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOAuthError";
  }
}

type InternalOAuthSession = {
  id: string;
  workspaceId: string;
  userId: string;
  scope: WorkspaceScope;
  providerId?: string;
  name: string;
  format: string;
  baseUrl: string;
  status: "waiting" | "completed" | "failed" | "cancelled";
  authUrl?: ProviderOAuthUrlInfo;
  deviceCode?: ProviderOAuthDeviceCodeInfo;
  info?: ProviderOAuthInfoNotice;
  prompt?: ProviderOAuthPrompt;
  progress: string[];
  error?: string;
  savedProviderId?: string;
  savedAt?: number;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
  initialLoginMethod?: string;
  initialEnterpriseDomain?: string;
  promptResolver?: (value: string) => void;
  promptRejecter?: (error: Error) => void;
  waiters: Set<() => void>;
};

const activeSessions = new Map<string, InternalOAuthSession>();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      session.abortController.abort(new Error("Login session expired"));
      activeSessions.delete(id);
    }
  }
}

/** Deterministic UUID v4 shape per workspace for OpenAI ChatGPT agent host registration. */
export function workspaceOAuthDeviceId(workspaceId: string): string {
  const hex = createHash("sha256")
    .update(`toolplane-oauth-device:${workspaceId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sanitizeOAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Authentication failed.";
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return cleaned || "Authentication failed.";
}

function snapshotSession(
  session: InternalOAuthSession,
): ProviderOAuthSessionSnapshot {
  return {
    sessionId: session.id,
    format: session.format,
    name: session.name,
    status: session.status,
    ...(session.authUrl ? { authUrl: session.authUrl } : {}),
    ...(session.deviceCode ? { deviceCode: session.deviceCode } : {}),
    ...(session.info ? { info: session.info } : {}),
    ...(session.prompt ? { prompt: session.prompt } : {}),
    progress: [...session.progress],
    ...(session.error ? { error: session.error } : {}),
    ...(session.savedProviderId ? { providerId: session.savedProviderId } : {}),
    ...(session.savedAt ? { savedAt: session.savedAt } : {}),
  };
}

function notifySessionWaiters(session: InternalOAuthSession) {
  session.updatedAt = Date.now();
  for (const waiter of session.waiters) {
    waiter();
  }
  session.waiters.clear();
}

async function waitForSessionChange(
  session: InternalOAuthSession,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  if (predicate()) {
    await delay(25);
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    session.waiters.delete(onUpdate);
    resolve();
  }, timeoutMs);
  const onUpdate = () => {
    if (!predicate()) {
      session.waiters.add(onUpdate);
      return;
    }
    clearTimeout(timer);
    resolve();
  };
  session.waiters.add(onUpdate);
  await promise;
  await delay(25);
}

function resolveOAuthProvider(format: string, name: string, baseUrl: string) {
  const builtinId = piProviderId(format);
  if (!builtinId) return null;
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const provider =
    builtinId === "radius"
      ? radiusProvider({
          id: "radius",
          name,
          ...(trimmedBaseUrl ? { gateway: trimmedBaseUrl } : {}),
        })
      : builtinProviders().find((candidate) => candidate.id === builtinId);
  if (!provider?.auth?.oauth) return null;
  return { builtinId, oauth: provider.auth.oauth };
}

async function persistCompletedOAuthLogin(
  session: InternalOAuthSession,
  credential: OAuthCredential,
): Promise<string> {
  const apiKey = serializeProviderCredential(credential);
  let targetProviderId = session.providerId;

  if (targetProviderId) {
    await updateProvider(session.scope, targetProviderId, {
      name: session.name,
      format: session.format,
      baseUrl: session.baseUrl,
      apiKey,
    });
  } else {
    let candidateName = session.name;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const created = await createProvider(session.scope, {
          name: candidateName,
          format: session.format,
          baseUrl: session.baseUrl,
          apiKey,
        });
        targetProviderId = created.id;
        session.name = candidateName;
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        candidateName = `${session.name} (${attempt + 1})`;
      }
    }
  }

  if (!targetProviderId) {
    throw new Error("Could not save the authenticated model provider.");
  }

  await refreshProviderModels(session.scope.id, targetProviderId, {
    name: session.name,
    format: session.format,
    baseUrl: session.baseUrl,
    apiKey,
  }).catch(() => null);
  revalidateProviderViews(session.scope.slug);

  return targetProviderId;
}

export async function startProviderOAuthSession(input: {
  scope: WorkspaceScope;
  userId: string;
  format: string;
  name: string;
  baseUrl?: string;
  providerId?: string;
  loginMethod?: string;
  enterpriseDomain?: string;
}): Promise<ProviderOAuthSessionSnapshot> {
  cleanupExpiredSessions();

  const name = input.name.trim();
  if (!name) {
    throw new ProviderOAuthError(
      "provider_name_required",
      "Provider name is required.",
    );
  }
  const baseUrl = (input.baseUrl ?? "").trim();
  const resolved = resolveOAuthProvider(input.format, name, baseUrl);
  if (!resolved) {
    throw new ProviderOAuthError(
      "provider_oauth_unsupported",
      "This provider does not support browser sign-in.",
    );
  }

  if (input.providerId) {
    const existing = await db.modelProvider.findFirst({
      where: { id: input.providerId, workspaceId: input.scope.id },
      select: { id: true },
    });
    if (!existing) {
      throw new ProviderOAuthError("provider_not_found", "Provider not found.");
    }
    const collision = await db.modelProvider.findFirst({
      where: {
        workspaceId: input.scope.id,
        name,
        id: { not: input.providerId },
      },
      select: { id: true },
    });
    if (collision) {
      throw new ProviderOAuthError(
        "provider_name_taken",
        "A provider with that name already exists.",
      );
    }
  } else {
    const collision = await db.modelProvider.findFirst({
      where: { workspaceId: input.scope.id, name },
      select: { id: true },
    });
    if (collision) {
      throw new ProviderOAuthError(
        "provider_name_taken",
        "A provider with that name already exists.",
      );
    }
  }

  // Cancel any previous pending login from the same user or on the same OAuth provider
  // so loopback callback ports (e.g. 1455, 53692) are released before starting.
  let cancelledExisting = false;
  for (const [id, existing] of activeSessions.entries()) {
    if (
      existing.status === "waiting" &&
      (existing.userId === input.userId || existing.format === input.format)
    ) {
      existing.status = "cancelled";
      existing.abortController.abort(new Error("Login cancelled"));
      activeSessions.delete(id);
      cancelledExisting = true;
    }
  }
  if (cancelledExisting) {
    await delay(60);
  }

  const session: InternalOAuthSession = {
    id: randomUUID(),
    workspaceId: input.scope.id,
    userId: input.userId,
    scope: input.scope,
    providerId: input.providerId,
    name,
    format: input.format,
    baseUrl,
    status: "waiting",
    progress: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    abortController: new AbortController(),
    initialLoginMethod: input.loginMethod?.trim() || undefined,
    initialEnterpriseDomain:
      input.enterpriseDomain !== undefined
        ? input.enterpriseDomain.trim()
        : undefined,
    waiters: new Set(),
  };

  activeSessions.set(session.id, session);

  const interaction: ProviderAuthInteraction = {
    signal: session.abortController.signal,
    notify(event: AuthEvent) {
      if (session.abortController.signal.aborted) return;
      if (event.type === "auth_url") {
        session.authUrl = {
          url: event.url,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        };
      } else if (event.type === "device_code") {
        session.deviceCode = {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.intervalSeconds !== undefined
            ? { intervalSeconds: event.intervalSeconds }
            : {}),
          ...(event.expiresInSeconds !== undefined
            ? { expiresInSeconds: event.expiresInSeconds }
            : {}),
        };
      } else if (event.type === "info") {
        session.info = {
          message: event.message,
          ...(event.links ? { links: event.links } : {}),
        };
      } else if (event.type === "progress") {
        session.progress = [...session.progress.slice(-9), event.message];
      }
      notifySessionWaiters(session);
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      session.abortController.signal.throwIfAborted();
      prompt.signal?.throwIfAborted();

      if (prompt.type === "select" && session.initialLoginMethod) {
        const chosen = prompt.options.find(
          (option) => option.id === session.initialLoginMethod,
        );
        session.initialLoginMethod = undefined;
        if (chosen) return chosen.id;
      }

      if (
        prompt.type === "text" &&
        resolved.builtinId === "github-copilot" &&
        session.initialEnterpriseDomain !== undefined
      ) {
        const domain = session.initialEnterpriseDomain;
        session.initialEnterpriseDomain = undefined;
        return domain;
      }

      const promptId = randomUUID();
      session.prompt = {
        id: promptId,
        type: prompt.type,
        message: prompt.message,
        ...("placeholder" in prompt && prompt.placeholder
          ? { placeholder: prompt.placeholder }
          : {}),
        ...(prompt.type === "select" ? { options: prompt.options } : {}),
      };
      notifySessionWaiters(session);

      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const cleanup = () => {
        session.abortController.signal.removeEventListener("abort", onAbort);
        prompt.signal?.removeEventListener("abort", onAbort);
        if (session.prompt?.id === promptId) {
          session.prompt = undefined;
        }
        session.promptResolver = undefined;
        session.promptRejecter = undefined;
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Login cancelled"));
      };
      session.abortController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      session.promptResolver = (value: string) => {
        cleanup();
        notifySessionWaiters(session);
        resolve(value);
      };
      session.promptRejecter = (error: Error) => {
        cleanup();
        notifySessionWaiters(session);
        reject(error);
      };
      return promise;
    },
  };

  void (async () => {
    try {
      const credential = await resolved.oauth.login(interaction, {
        getDeviceId: () => workspaceOAuthDeviceId(input.scope.id),
        agentName: "ToolPlane",
      });
      if (session.abortController.signal.aborted) return;
      const savedProviderId = await persistCompletedOAuthLogin(
        session,
        credential,
      );
      session.savedProviderId = savedProviderId;
      session.savedAt = Date.now();
      session.status = "completed";
      session.prompt = undefined;
      notifySessionWaiters(session);
    } catch (error) {
      if (
        session.abortController.signal.aborted ||
        session.status === "cancelled"
      ) {
        session.status = "cancelled";
      } else {
        session.status = "failed";
        session.error = sanitizeOAuthError(error);
      }
      session.prompt = undefined;
      notifySessionWaiters(session);
    }
  })();

  await waitForSessionChange(
    session,
    () =>
      session.status !== "waiting" ||
      Boolean(session.authUrl) ||
      Boolean(session.deviceCode) ||
      Boolean(session.prompt),
    INITIAL_WAIT_TIMEOUT_MS,
  );

  return snapshotSession(session);
}

function getAuthorizedSession(
  workspaceId: string,
  userId: string,
  sessionId: string,
): InternalOAuthSession {
  cleanupExpiredSessions();
  const session = activeSessions.get(sessionId);
  if (
    !session ||
    session.workspaceId !== workspaceId ||
    session.userId !== userId
  ) {
    throw new ProviderOAuthError(
      "session_not_found",
      "Login session not found or expired.",
    );
  }
  return session;
}

export function getProviderOAuthSessionStatus(input: {
  workspaceId: string;
  userId: string;
  sessionId: string;
}): ProviderOAuthSessionSnapshot {
  const session = getAuthorizedSession(
    input.workspaceId,
    input.userId,
    input.sessionId,
  );
  return snapshotSession(session);
}

export async function submitProviderOAuthInput(input: {
  workspaceId: string;
  userId: string;
  sessionId: string;
  value: string;
}): Promise<ProviderOAuthSessionSnapshot> {
  const session = getAuthorizedSession(
    input.workspaceId,
    input.userId,
    input.sessionId,
  );
  if (session.status !== "waiting" || !session.promptResolver) {
    throw new ProviderOAuthError(
      "prompt_not_active",
      "This login session is not waiting for input.",
    );
  }
  const previousPromptId = session.prompt?.id;
  session.promptResolver(input.value);

  await waitForSessionChange(
    session,
    () =>
      session.status !== "waiting" ||
      (session.prompt !== undefined && session.prompt.id !== previousPromptId),
    INPUT_WAIT_TIMEOUT_MS,
  );

  return snapshotSession(session);
}

export function cancelProviderOAuthSession(input: {
  workspaceId: string;
  userId: string;
  sessionId: string;
}): ProviderOAuthSessionSnapshot {
  const session = getAuthorizedSession(
    input.workspaceId,
    input.userId,
    input.sessionId,
  );
  session.status = "cancelled";
  session.prompt = undefined;
  session.abortController.abort(new Error("Login cancelled"));
  activeSessions.delete(session.id);
  notifySessionWaiters(session);
  return snapshotSession(session);
}
