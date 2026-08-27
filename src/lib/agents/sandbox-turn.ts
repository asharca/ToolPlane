import 'server-only';
import { db } from '@/lib/db';
import {
  createAgentRuntimeToken,
  runtimeMcpProxyUrl,
  runtimeModelProxyBase,
} from './runtime-access';
import {
  runSandboxAgentTurn,
  type SandboxAgentRuntimeKind,
  type SandboxRuntimeActivity,
  type SandboxRuntimeMessage,
  type SandboxRuntimeProvider,
} from './sandbox-runtime';
import type { SkillForPrompt } from './resolve';
import type { ContextUsageSnapshot } from '@/lib/context-usage';
import { resolveModelContext, type ProviderConfig } from './model';
import { liveStatus } from '@/lib/process/supervisor';

type SandboxTurnAgent = {
  id: string;
  workspaceId: string;
  runtimeKind: string;
  provider: (ProviderConfig & SandboxRuntimeProvider & { id: string }) | null;
  model: string | null;
};

export async function runDedicatedSandboxTurn(input: {
  agent: SandboxTurnAgent;
  sandboxId?: string | null;
  systemPrompt?: string | null;
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  deploymentIds?: readonly string[];
  workingDirectory?: string | null;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
}): Promise<string> {
  const runtimeKind = input.agent.runtimeKind;
  if (runtimeKind !== 'pi' && runtimeKind !== 'claude-code' && runtimeKind !== 'dsh') {
    throw new Error(`Unsupported sandbox runtime: ${runtimeKind}.`);
  }
  const provider = input.agent.provider;
  const modelId = input.agent.model;
  if (!provider?.id || !modelId) throw new Error('This Agent has no configured model.');
  const modelContext = resolveModelContext(provider, modelId);

  const links = await db.agentSandbox.findMany({
    where: {
      agentId: input.agent.id,
    },
    select: {
      sandboxId: true,
      isDefault: true,
      sandbox: { select: { workspaceId: true, kind: true, network: true } },
    },
  });
  const link = links.find((candidate) => candidate.isDefault) ?? links[0];
  if (
    links.length !== 1
    || !link
    || link.sandbox.workspaceId !== input.agent.workspaceId
    || link.sandbox.kind !== 'docker'
    || link.sandbox.network === 'none'
    || (input.sandboxId && link.sandboxId !== input.sandboxId)
  ) {
    throw new Error('Assign exactly one Docker sandbox to this Agent before running it.');
  }

  const deploymentIds = [...new Set(input.deploymentIds ?? [])]
    .filter((deploymentId) => liveStatus(deploymentId) === 'running');
  const now = Math.floor(Date.now() / 1000);
  const runtimeAccessToken = await createAgentRuntimeToken({
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    sandboxId: link.sandboxId,
    providerId: provider.id,
    deploymentIds,
    exp: now + 55 * 60,
  });

  return runSandboxAgentTurn({
    runtimeKind: runtimeKind as SandboxAgentRuntimeKind,
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    sandboxId: link.sandboxId,
    provider,
    modelId,
    contextWindow: modelContext.maxTokens,
    contextWindowEstimated: modelContext.estimated,
    modelProxyBase: runtimeModelProxyBase(provider.id),
    runtimeAccessToken,
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    skills: input.skills,
    mcpServers: deploymentIds.map((deploymentId) => ({
      deploymentId,
      url: runtimeMcpProxyUrl(deploymentId),
    })),
    workingDirectory: input.workingDirectory,
    signal: input.signal,
    onTextDelta: input.onTextDelta,
    onActivity: input.onActivity,
    onContextUsage: input.onContextUsage,
  });
}
