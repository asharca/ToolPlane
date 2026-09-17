import { openCollaborationRun, closeCollaborationRun, cancelRunTasks, assertCollaborationContext } from './collaboration/service';
import { COLLABORATION_MCP_ID, COLLABORATION_INSTRUCTIONS } from './collaboration/protocol';
import { runtimeCollaborationMcpUrl } from './runtime-access';
import { observe, recordEvent } from '@/lib/observability/events';
import 'server-only';
import { isDedicatedSandboxRuntimeKind } from './runtime-kind';
import { bindHermesRpcConversation } from './hermes-rpc-session-binding';
import { normalizeSandboxWorkingDirectory } from './sandbox-runtime';
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
import type { RuntimeCommand, RuntimeUsage } from './runtime-commands';

type SandboxTurnAgent = {
  id: string;
  workspaceId: string;
  runtimeKind: string;
  disabledBuiltinTools: string[];
  provider: (ProviderConfig & SandboxRuntimeProvider & { id: string }) | null;
  model: string | null;
  maxSteps?: number;
};

export async function runDedicatedSandboxTurn(input: {
  agent: SandboxTurnAgent;
  sandboxId?: string | null;
  systemPrompt?: string | null;
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  deploymentIds?: readonly string[];
  workingDirectory?: string | null;
  collaboration?: { targetIds: readonly string[]; taskId?: string; workSessionId?: string };
  runtimeSessionId?: string;
  command?: string;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
  onCommands?: (commands: RuntimeCommand[]) => void | Promise<void>;
  onUsage?: (usage: RuntimeUsage) => void | Promise<void>;
}): Promise<string> {
  return observe({ domain: 'agent', eventName: 'sandbox.run', workspaceId: input.agent.workspaceId, agentId: input.agent.id,
    model: input.agent.model ?? undefined, providerId: input.agent.provider?.id, secrets: [input.agent.provider?.apiKey ?? ''] }, async () => {
  const runtimeKind = input.agent.runtimeKind;
  if (!isDedicatedSandboxRuntimeKind(runtimeKind)) {
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

  if (input.runtimeSessionId) await assertCollaborationContext(input.runtimeSessionId, input.collaboration?.taskId);
  if (runtimeKind === 'hermes-rpc' && input.runtimeSessionId) {
    await bindHermesRpcConversation({ workspaceId: input.agent.workspaceId, agentId: input.agent.id,
      conversationId: input.runtimeSessionId, sandboxId: link.sandboxId, providerId: provider.id,
      modelId, providerFormat: provider.format, workingDirectory: normalizeSandboxWorkingDirectory(input.workingDirectory) });
  }
  const deploymentIds = [...new Set(input.deploymentIds ?? [])]
    .filter((deploymentId) => liveStatus(deploymentId) === 'running');
  const collaboration = input.collaboration && (input.collaboration.targetIds.length || input.collaboration.taskId)
    ? await openCollaborationRun({ workspaceId: input.agent.workspaceId, agentId: input.agent.id,
        sandboxId: link.sandboxId, providerId: provider.id, conversationId: input.runtimeSessionId,
        ...input.collaboration }) : null;
  const now = Math.floor(Date.now() / 1000);
  const effectiveSignal = collaboration
    ? AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(Math.max(1, collaboration.deadlineAt.getTime() - Date.now()))])
    : input.signal;
  try {
  const runtimeAccessToken = await createAgentRuntimeToken({
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    sandboxId: link.sandboxId,
    providerId: provider.id,
    deploymentIds,
    exp: now + 55 * 60,
    ...(collaboration ? { collaborationRunId: collaboration.id } : {}),
  });

  return await runSandboxAgentTurn({
    runtimeKind: runtimeKind as SandboxAgentRuntimeKind,
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    sandboxId: link.sandboxId,
    provider,
    modelId,
    maxSteps: input.agent.maxSteps,
    contextWindow: modelContext.maxTokens,
    contextWindowEstimated: modelContext.estimated,
    modelProxyBase: runtimeModelProxyBase(provider.id),
    runtimeAccessToken,
    systemPrompt: collaboration ? [input.systemPrompt, COLLABORATION_INSTRUCTIONS].filter(Boolean).join('\n\n') : input.systemPrompt,
    disabledBuiltinTools: input.agent.disabledBuiltinTools,
    messages: input.messages,
    skills: input.skills,
    mcpServers: [...deploymentIds.map((deploymentId) => ({
      deploymentId, url: runtimeMcpProxyUrl(deploymentId),
    })), ...(collaboration ? [{ deploymentId: COLLABORATION_MCP_ID, url: runtimeCollaborationMcpUrl(collaboration.id) }] : [])],
    workingDirectory: input.workingDirectory,
    runtimeSessionId: input.runtimeSessionId,
    command: input.command,
    signal: effectiveSignal,
    onTextDelta: input.onTextDelta,
    onActivity: async (activity) => {
      if (activity.type === 'tool') await recordEvent({ domain: 'agent', eventName: 'sandbox.tool',
        toolName: activity.toolName, outcome: activity.status === 'failed' ? 'error' : 'success',
        attributes: { status: activity.status, toolCallId: activity.toolCallId } });
      await input.onActivity?.(activity);
    },
    onContextUsage: input.onContextUsage,
    onCommands: input.onCommands,
    onUsage: input.onUsage,
  });
  } catch (error) {
    if (collaboration) await cancelRunTasks(collaboration.id);
    throw error;
  } finally {
    if (collaboration) {
      try { if (effectiveSignal?.aborted) await cancelRunTasks(collaboration.id); }
      finally { await closeCollaborationRun(collaboration.id); }
    }
  }

  });
}
