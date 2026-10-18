import { observe, recordEvent } from "@/lib/observability/events";
import "server-only";
import { isDedicatedSandboxRuntimeKind } from "./runtime-kind";
import { bindHermesRpcConversation } from "./hermes-rpc-session-binding";
import { normalizeSandboxWorkingDirectory } from "./sandbox-runtime";
import { db } from "@/lib/db";
import {
  createAgentRuntimeToken,
  runtimeMcpProxyUrl,
  runtimeModelProxyBase,
} from "./runtime-access";
import {
  runSandboxAgentTurn,
  compactPiHarnessSession,
} from "./sandbox-runtime";
import type {
  PiHarnessOperationResult,
  RunSandboxAgentTurnOptions,
  SandboxAgentRuntimeKind,
  SandboxRuntimeActivity,
  SandboxRuntimeMessage,
  SandboxRuntimeProvider,
} from "./sandbox-runtime";
import type { ResolvedAgentPiPackage, SkillForPrompt } from "./resolve";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { resolveModelContext, type ProviderConfig } from "./model";
import { liveStatus } from "@/lib/process/supervisor";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "./runtime-commands";
import { ensureAgentConversationSandbox } from "./conversation-sandbox";
import { withAgentExecutionLease } from "./agent-execution-gate";

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
  nativeCompaction?: {
    contextId: string;
    customInstructions: string;
    onResult: (result: PiHarnessOperationResult) => void;
  };
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
          if (!isDedicatedSandboxRuntimeKind(runtimeKind)) {
            throw new Error(`Unsupported sandbox runtime: ${runtimeKind}.`);
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
          if (conversationId)
            await db.workSession.updateMany({
              where: {
                conversationId,
                agentId: input.agent.id,
                workspaceId: input.agent.workspaceId,
              },
              data: { sandboxId: link.sandboxId },
            });

          if (runtimeKind === "hermes-rpc" && conversationId) {
            await bindHermesRpcConversation({
              workspaceId: input.agent.workspaceId,
              agentId: input.agent.id,
              conversationId,
              sandboxId: link.sandboxId,
              providerId: provider.id,
              modelId,
              providerFormat: provider.format,
              workingDirectory: normalizeSandboxWorkingDirectory(
                input.workingDirectory,
              ),
            });
          }
          const deploymentIds = [...new Set(input.deploymentIds ?? [])].filter(
            (deploymentId) => liveStatus(deploymentId) === "running",
          );
          const now = Math.floor(Date.now() / 1000);
          const runtimeAccessToken = await createAgentRuntimeToken({
            workspaceId: input.agent.workspaceId,
            agentId: input.agent.id,
            sandboxId: link.sandboxId,
            conversationId,
            a2aContextId: input.a2aContextId,
            providerId: provider.id,
            deploymentIds,
            exp: now + 55 * 60,
          });

          const options: RunSandboxAgentTurnOptions = {
            runtimeKind: runtimeKind as SandboxAgentRuntimeKind,
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
            systemPrompt: input.systemPrompt,
            disabledBuiltinTools: input.agent.disabledBuiltinTools,
            messages: input.messages,
            skills: input.skills,
            ...(runtimeKind === "pi-sdk"
              ? { piPackages: input.piPackages }
              : {}),
            mcpServers: deploymentIds.map((deploymentId) => ({
              deploymentId,
              url: runtimeMcpProxyUrl(deploymentId),
            })),
            workingDirectory: input.workingDirectory,
            runtimeSessionId,
            command: input.command,
            signal: input.signal,
            onTextDelta: input.onTextDelta,
            onActivity: async (activity) => {
              if (activity.type === "tool")
                await recordEvent({
                  domain: "agent",
                  eventName: "sandbox.tool",
                  toolName: activity.toolName,
                  outcome: activity.status === "failed" ? "error" : "success",
                  attributes: {
                    status: activity.status,
                    toolCallId: activity.toolCallId,
                  },
                });
              await input.onActivity?.(activity);
            },
            onContextUsage: input.onContextUsage,
            onCommands: input.onCommands,
            onUsage: input.onUsage,
            onCommandResult: input.onCommandResult,
          };
          if (input.nativeCompaction) {
            const result = await compactPiHarnessSession(
              options,
              input.nativeCompaction.contextId,
              input.nativeCompaction.customInstructions,
            );
            input.nativeCompaction.onResult(result);
            return result.text;
          }
          return runSandboxAgentTurn(options);
        },
      ),
  );
}
