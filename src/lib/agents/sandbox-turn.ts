import { observe, recordEvent } from "@/lib/observability/events";
import "server-only";
import { db } from "@/lib/db";
import {
  createAgentRuntimeToken,
  runtimeMcpProxyUrl,
  runtimeModelProxyBase,
  sandboxRuntimeOrigin,
} from "./runtime-access";
import { runSandboxAgentTurn } from "./sandbox-runtime";
import type {
  AgentPromptInvocation,
  RunSandboxAgentTurnOptions,
  SandboxRuntimeActivity,
  SandboxRuntimeMessage,
  SandboxRuntimeProvider,
} from "./sandbox-runtime";
import type { ResolvedAgentPiPackage, SkillForPrompt } from "./resolve";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { resolveModelContext, type ProviderConfig } from "./model";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "./runtime-commands";
import { ensureAgentConversationSandbox } from "./conversation-sandbox";
import { withAgentExecutionLease } from "./agent-execution-gate";
import { resolvePiSessionPackages } from "./pi-session-packages";
import { getAgentForRun } from "./queries";
import { resolvePinnedAgent } from "./revisions";
import { resolveAgentTools, resolveAgentPiPackages } from "./resolve";
import type { ReasoningEffort } from "./constants";
import type { AgentModelOverride } from "./chat-body";
import { resolveAgentModelOverride } from "./turn-model";
import { resolveSessionExternalSandboxes } from "./external-sandboxes";

import { withWorkUiLease } from "./execution/work-ui";
type SandboxTurnAgent = {
  id: string;
  workspaceId: string;
  runtimeKind: string;
  disabledBuiltinTools: string[];
  provider: (ProviderConfig & SandboxRuntimeProvider & { id: string }) | null;
  model: string | null;
  maxSteps?: number;
};

export type RunDedicatedSandboxTurnInput = {
  agent: SandboxTurnAgent;
  conversationId?: string;
  a2aContextId?: string;
  wait?: boolean;
  systemPrompt?: string | null;
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  piPackages?: readonly ResolvedAgentPiPackage[];
  deploymentIds?: readonly string[];
  workingDirectory?: string | null;
  runtimeSessionId?: string;
  command?: string;
  reasoningEffort?: ReasoningEffort;
  modelOverride?: AgentModelOverride;
  historyRequired?: boolean;
  onPromptInvocation?: (
    invocation: AgentPromptInvocation,
  ) => void | Promise<void>;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
  onCommands?: (commands: RuntimeCommand[]) => void | Promise<void>;
  onUsage?: (usage: RuntimeUsage) => void | Promise<void>;
  onCommandResult?: (result: RuntimeCommandResult) => void | Promise<void>;
};

export async function runDedicatedSandboxTurn(
  input: RunDedicatedSandboxTurnInput,
): Promise<string> {
  const conversationId = input.conversationId;
  const sessionId = conversationId ?? input.a2aContextId;
  const runtimeSessionId =
    input.runtimeSessionId ?? input.a2aContextId ?? conversationId;
  if (!sessionId)
    throw new Error(
      "A conversation or context is required for dedicated execution.",
    );
  const [liveAgent, conversation, context] = await Promise.all([
    getAgentForRun(input.agent.id, input.agent.workspaceId),
    conversationId
      ? db.conversation.findFirst({
          where: {
            id: conversationId,
            agentId: input.agent.id,
            agent: { workspaceId: input.agent.workspaceId },
          },
        })
      : null,
    input.a2aContextId
      ? db.a2AContext.findFirst({
          where: {
            id: input.a2aContextId,
            agentId: input.agent.id,
            workspaceId: input.agent.workspaceId,
            targetKind: "local",
          },
        })
      : null,
  ]);
  if (
    !liveAgent ||
    (conversationId && !conversation) ||
    (input.a2aContextId && !context)
  )
    throw new Error("Session does not belong to this Agent.");
  if (
    conversation &&
    context &&
    conversation.agentRevisionId !== context.agentRevisionId
  )
    throw new Error("Session revision bindings conflict.");
  const agent = await resolvePinnedAgent(
    liveAgent,
    (conversation ?? context)?.agentRevisionId,
  );
  const effective = input.modelOverride
    ? await resolveAgentModelOverride(
        agent.workspaceId,
        input.modelOverride,
        agent.runtimeKind,
      )
    : { provider: agent.provider, model: agent.model };
  const resolved = resolveAgentTools(agent);
  input = {
    ...input,
    agent: { ...agent, ...effective },
    systemPrompt: agent.systemPrompt,
    skills: resolved.skills,
    piPackages: resolveAgentPiPackages(agent),
    deploymentIds: resolved.deploymentIds,
  };
  if (
    runtimeSessionId !== conversationId &&
    runtimeSessionId !== input.a2aContextId
  )
    throw new Error(
      "Native session does not match the conversation/context binding.",
    );
  return withAgentExecutionLease(
    {
      agentId: input.agent.id,
      sessionId,
      signal: input.signal,
      wait: input.wait,
    },
    () =>
      observe(
        {
          domain: "agent",
          eventName: "sandbox.run",
          workspaceId: input.agent.workspaceId,
          agentId: input.agent.id,
          model: input.agent.model ?? undefined,
          providerId: input.agent.provider?.id,
          secrets: [input.agent.provider?.apiKey ?? ""],
        },
        async () => {
          const runtimeKind = input.agent.runtimeKind;
          if (runtimeKind !== "pi-sdk") {
            throw new Error("Historical Agent sessions are read-only.");
          }
          if (runtimeKind === "pi-sdk" && !input.piPackages)
            throw new Error("PI_PACKAGE_UNAVAILABLE");
          const provider = input.agent.provider;
          const modelId = input.agent.model;
          if (!provider?.id || !modelId)
            throw new Error("This Agent has no configured model.");
          const modelContext = resolveModelContext(provider, modelId);

          const link = await ensureAgentConversationSandbox({
            workspaceId: input.agent.workspaceId,
            agentId: input.agent.id,
            conversationId,
            contextId: input.a2aContextId,
            signal: input.signal,
          });
          const piSession =
            runtimeKind === "pi-sdk"
              ? await resolvePiSessionPackages({
                  workspaceId: input.agent.workspaceId,
                  agentId: input.agent.id,
                  sandboxId: link.sandboxId,
                  conversationId,
                  contextId: input.a2aContextId,
                  runtimeSessionId,
                })
              : undefined;
          if (conversationId)
            await db.workSession.updateMany({
              where: {
                conversationId,
                agentId: input.agent.id,
                workspaceId: input.agent.workspaceId,
              },
              data: { sandboxId: link.sandboxId },
            });

          const deploymentIds = [
            ...new Set(piSession?.deploymentIds ?? input.deploymentIds ?? []),
          ];
          const externalSandboxes = await resolveSessionExternalSandboxes({
            workspaceId: input.agent.workspaceId,
            agentId: input.agent.id,
            pinned: agent.revisionConfig.externalSandboxes,
          });
          const now = Math.floor(Date.now() / 1000);
          const runtimeAccessToken = await createAgentRuntimeToken({
            workspaceId: input.agent.workspaceId,
            agentRevisionId: agent.agentRevisionId,
            agentId: input.agent.id,
            sandboxId: link.sandboxId,
            conversationId,
            a2aContextId: input.a2aContextId,
            providerId: provider.id,
            modelOverride: input.modelOverride,
            deploymentIds,
            externalSandboxIds: externalSandboxes.map(
              (entry) => entry.sandboxId,
            ),
            exp: now + 55 * 60,
          });

          const runningTools = new Map<
            string,
            SandboxRuntimeActivity & { startedAt: number }
          >();
          const options: RunSandboxAgentTurnOptions = {
            runtimeKind,
            piVersion: agent.revisionConfig.environment.piVersion,
            workspaceId: input.agent.workspaceId,
            agentId: input.agent.id,
            sandboxId: link.sandboxId,
            conversationId,
            a2aContextId: input.a2aContextId,
            provider,
            modelId,
            maxSteps: input.agent.maxSteps,
            contextWindow: modelContext.maxTokens,
            contextWindowEstimated: modelContext.estimated,
            modelProxyBase: runtimeModelProxyBase(provider.id),
            runtimeAccessToken,
            nativeUiUrl: `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/sessions/ui`,
            systemPrompt: input.systemPrompt,
            disabledBuiltinTools: input.agent.disabledBuiltinTools,
            messages: input.messages,
            skills: input.skills,
            piPackages: piSession?.packages,
            mcpServers: [
              ...deploymentIds.map((deploymentId) => ({
                deploymentId,
                url: runtimeMcpProxyUrl(deploymentId),
              })),
              ...externalSandboxes,
            ],
            workingDirectory: input.workingDirectory,
            runtimeSessionId,
            agentRevisionId: agent.agentRevisionId,
            command: input.command,
            reasoningEffort: input.reasoningEffort,
            historyRequired: input.historyRequired,
            onPromptInvocation: input.onPromptInvocation,
            signal: input.signal,
            onTextDelta: input.onTextDelta,
            onActivity: async (activity) => {
              if (activity.type === "tool" && activity.toolCallId) {
                const started = runningTools.get(activity.toolCallId);
                const merged = {
                  ...started,
                  ...activity,
                  input: activity.input ?? started?.input,
                };
                if (activity.status === "running") {
                  runningTools.set(activity.toolCallId, {
                    ...merged,
                    startedAt: started?.startedAt ?? Date.now(),
                  });
                } else {
                  runningTools.delete(activity.toolCallId);
                  // One record per finished call; workspace members read it in the Agent tool log.
                  await recordEvent({
                    domain: "agent",
                    eventName: "sandbox.tool",
                    toolName: merged.originalToolName ?? merged.toolName,
                    deploymentId: merged.deploymentId,
                    outcome: activity.status === "failed" ? "error" : "success",
                    durationMs:
                      activity.durationMs ??
                      (started ? Date.now() - started.startedAt : undefined),
                    attributes: { toolCallId: activity.toolCallId },
                    detail: {
                      request: merged.input ?? null,
                      response: activity.output ?? null,
                    },
                  });
                }
              }
              await input.onActivity?.(activity);
            },
            onContextUsage: input.onContextUsage,
            onCommands: input.onCommands,
            onUsage: input.onUsage,
            onCommandResult: input.onCommandResult,
          };
          return withWorkUiLease(
            {
              conversationId,
              workspaceId: agent.workspaceId,
              agentId: agent.id,
              agentRevisionId: agent.agentRevisionId,
            },
            runtimeAccessToken,
            (enabled) =>
              runSandboxAgentTurn({
                ...options,
                nativeUiUrl: enabled ? options.nativeUiUrl : undefined,
              }),
          );
        },
      ),
  );
}
