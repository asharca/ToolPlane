import 'server-only';
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { AGENT_MAX_DEPTH, resolveMaxSteps } from './constants';
import { agentTool, type AgentToolSet } from './agent-tool';
import { runNativeAgent } from './native';
import { resolveAgentTools, type LoadedAgentTools, type SkillForPrompt, type SubAgentRef } from './resolve';
import { assembleSystemPrompt } from './system-prompt';
import type { ProviderConfig } from './model';
import { buildToolSet } from './tools';
import { buildSkillToolSet } from './skill-tools';
import { buildKnowledgeTool } from '@/lib/knowledge';
import { getAgentForRun } from './queries';
import { runHermesText } from './hermes/client';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from './hermes/runtime';
import { implementedAgentRuntimeKind, isDedicatedSandboxRuntimeKind } from './runtime-kind';
import { runDedicatedSandboxTurn } from './sandbox-turn';

export type AgentRunContext = {
  workspaceId: string;
  depth: number;
  visited: Set<string>;
};

// What runAgentTurn needs from a loaded sub-agent: its identity, model config,
// and tool relations (for resolveAgentTools).
export type RunAgent = LoadedAgentTools & {
  id?: string;
  slug?: string;
  workspaceId?: string;
  name: string;
  runtimeKind: string;
  systemPrompt: string | null;
  model: string | null;
  maxSteps: number;
  provider: ProviderConfig | null;
  modelProviders?: Array<{ provider: ProviderConfig }>;
  runtime?: { id: string; kind: string } | null;
};

// Injectable so unit tests can exercise the cycle/depth guards and delegation
// without a real DB or model call.
export type RunDeps = {
  loadAgent: (agentId: string, workspaceId: string) => Promise<RunAgent | null>;
  runModel: (args: {
    model: ProviderConfig;
    modelId: string;
    system: string;
    prompt: string;
    tools: AgentToolSet;
    maxSteps: number;
  }) => Promise<string>;
  runSandboxModel?: (args: Parameters<typeof runDedicatedSandboxTurn>[0]) => Promise<string>;
};

const defaultDeps: RunDeps = {
  loadAgent: (id, workspaceId) => getAgentForRun(id, workspaceId),
  runModel: async ({ model, modelId, system, prompt, tools, maxSteps }) => runNativeAgent({
    provider: model,
    modelId,
    systemPrompt: system,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools,
    maxSteps: resolveMaxSteps(maxSteps),
  }),
  runSandboxModel: runDedicatedSandboxTurn,
};

export function subAgentToolKey(slug: string): string {
  return `agent_${slug.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// Builds an agent's full tool set: its MCP deployment tools (reused from
// buildToolSet) plus one `agent_<slug>` tool per attached sub-agent. Calling a
// sub-agent tool runs that agent's own loop and returns its final text.
export async function buildAgentToolSet(
  resolved: {
    deploymentIds: string[];
    sandboxDeploymentIds?: string[];
    skills?: SkillForPrompt[];
    subAgents: SubAgentRef[];
    knowledgeBases?: Array<{ knowledgeBase: { id: string; embeddingModel: string; topK: number; threshold: number; provider: { format: string; baseUrl: string; apiKey: string } | null } }>;
  },
  ctx: AgentRunContext,
  deps: RunDeps = defaultDeps,
): Promise<AgentToolSet> {
  const set = await buildToolSet(resolved.deploymentIds, ctx.workspaceId);
  Object.assign(set, buildSkillToolSet(resolved.skills ?? [], { sandboxDeploymentIds: resolved.sandboxDeploymentIds ?? [] }));
  Object.assign(set, buildKnowledgeTool((resolved.knowledgeBases ?? []).map((link) => link.knowledgeBase)));
  for (const sub of resolved.subAgents) {
    set[subAgentToolKey(sub.slug)] = agentTool({
      name: subAgentToolKey(sub.slug),
      description: `Delegate a task to the "${sub.name}" sub-agent. ${sub.description ?? ''}`.trim(),
      parameters: Type.Object({
        prompt: Type.String({ description: 'The task or question for the sub-agent.' }),
      }),
      execute: async ({ prompt }: { prompt: string }) => ({
        text: await runAgentTurn(sub.id, String(prompt), ctx, deps),
      }),
    });
  }
  return set;
}

// Runs one sub-agent turn. Returns the agent's final text, or a refusal/error
// string (never throws) so a bad config degrades gracefully instead of crashing
// the parent's stream.
export async function runAgentTurn(
  agentId: string,
  prompt: string,
  ctx: AgentRunContext,
  deps: RunDeps = defaultDeps,
): Promise<string> {
  if (ctx.visited.has(agentId)) {
    return `Refused: sub-agent cycle detected (${agentId}).`;
  }
  if (ctx.depth >= AGENT_MAX_DEPTH) {
    return 'Refused: max sub-agent depth reached.';
  }

  const agent = await deps.loadAgent(agentId, ctx.workspaceId);
  if (!agent) return `Sub-agent ${agentId} not found in this workspace.`;
  const runtimeKind = implementedAgentRuntimeKind(agent.runtimeKind);
  if (!runtimeKind) return `Sub-agent runtime "${agent.runtimeKind}" is not available.`;
  const isHermes = runtimeKind === 'hermes';
  if (isHermes ? !agent.modelProviders?.length : !agent.provider || !agent.model) {
    if (isHermes) return `Hermes sub-agent "${agent.name}" has no model provider configured.`;
    return `Sub-agent "${agent.name}" has no model configured.`;
  }

  if (isHermes) {
    const writeLease = acquireHermesRuntimeWriteLease(ctx.workspaceId, agentId);
    if (!writeLease) return `Hermes sub-agent unavailable: ${HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR}`;
    const sessionId = randomUUID();
    try {
      return await runHermesText({
        agent: {
          id: agentId,
          slug: agent.slug ?? agentId,
          workspaceId: ctx.workspaceId,
          runtime: agent.runtime ?? null,
        },
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] }],
        sessionId,
        sessionKey: `agent:${agentId}:subagent:${sessionId}`,
        writeLease,
      });
    } catch (error) {
      return `Hermes sub-agent failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      writeLease.release();
    }
  }

  if (!agent.provider || !agent.model) {
    return `Sub-agent "${agent.name}" has no model configured.`;
  }

  const resolved = resolveAgentTools(agent);
  if (isDedicatedSandboxRuntimeKind(runtimeKind)) {
    if (!agent.provider.id) return `Sub-agent "${agent.name}" has an invalid model provider.`;
    if (!deps.runSandboxModel) return `Sub-agent runtime "${runtimeKind}" is not configured in this runner.`;
    try {
      return await deps.runSandboxModel({
        agent: {
          ...agent,
          id: agentId,
          workspaceId: ctx.workspaceId,
          provider: { ...agent.provider, id: agent.provider.id },
        },
        systemPrompt: agent.systemPrompt,
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
        skills: resolved.skills,
        deploymentIds: resolved.deploymentIds,
      });
    } catch (error) {
      return `${agent.name} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const childCtx: AgentRunContext = {
    workspaceId: ctx.workspaceId,
    depth: ctx.depth + 1,
    visited: new Set([...ctx.visited, agentId]),
  };
  const tools = await buildAgentToolSet(resolved, childCtx, deps);
  const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills, Boolean(resolved.knowledgeBases?.length));
  const model = agent.provider;

  return deps.runModel({ model, modelId: agent.model, system, prompt, tools, maxSteps: agent.maxSteps });
}
