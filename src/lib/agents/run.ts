import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  generateText,
  jsonSchema,
  tool,
  stepCountIs,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import { AGENT_MAX_DEPTH, resolveMaxSteps } from './constants';
import { resolveAgentTools, type LoadedAgentTools, type SkillForPrompt, type SubAgentRef } from './resolve';
import { assembleSystemPrompt, prependSystemModelMessage } from './system-prompt';
import { buildModel, type ProviderConfig } from './model';
import { buildToolSet } from './tools';
import { buildSkillToolSet } from './skill-tools';
import { getAgentForRun } from './queries';
import { runHermesText } from './hermes/client';

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
  systemPrompt: string | null;
  model: string | null;
  maxSteps: number;
  provider: ProviderConfig | null;
  runtime?: { id: string; kind: string } | null;
};

// Injectable so unit tests can exercise the cycle/depth guards and delegation
// without a real DB or model call.
export type RunDeps = {
  loadAgent: (agentId: string, workspaceId: string) => Promise<RunAgent | null>;
  runModel: (args: {
    model: LanguageModel;
    system: string;
    prompt: string;
    tools: ToolSet;
    maxSteps: number;
  }) => Promise<string>;
};

const defaultDeps: RunDeps = {
  loadAgent: (id, workspaceId) => getAgentForRun(id, workspaceId),
  runModel: async ({ model, system, prompt, tools, maxSteps }) => {
    const messages = prependSystemModelMessage(system, [{ role: 'user', content: prompt }]);
    const { text } = await generateText({
      model,
      allowSystemInMessages: true,
      messages,
      tools,
      stopWhen: stepCountIs(resolveMaxSteps(maxSteps)),
    });
    return text;
  },
};

export function subAgentToolKey(slug: string): string {
  return `agent_${slug.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// Builds an agent's full tool set: its MCP deployment tools (reused from
// buildToolSet) plus one `agent_<slug>` tool per attached sub-agent. Calling a
// sub-agent tool runs that agent's own loop and returns its final text.
export async function buildAgentToolSet(
  resolved: { deploymentIds: string[]; sandboxDeploymentIds?: string[]; skills?: SkillForPrompt[]; subAgents: SubAgentRef[] },
  ctx: AgentRunContext,
  deps: RunDeps = defaultDeps,
): Promise<ToolSet> {
  const set = await buildToolSet(resolved.deploymentIds, ctx.workspaceId);
  Object.assign(set, buildSkillToolSet(resolved.skills ?? [], { sandboxDeploymentIds: resolved.sandboxDeploymentIds ?? [] }));
  for (const sub of resolved.subAgents) {
    set[subAgentToolKey(sub.slug)] = tool({
      description: `Delegate a task to the "${sub.name}" sub-agent. ${sub.description ?? ''}`.trim(),
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task or question for the sub-agent.' },
        },
        required: ['prompt'],
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
  if (!agent.provider || !agent.model) {
    return `Sub-agent "${agent.name}" has no model configured.`;
  }

  if (agent.runtime?.kind === 'hermes') {
    const sessionId = randomUUID();
    try {
      return await runHermesText({
        agent: {
          id: agentId,
          slug: agent.slug ?? agentId,
          workspaceId: ctx.workspaceId,
          runtime: agent.runtime,
        },
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] }],
        sessionId,
        sessionKey: `agent:${agentId}:subagent:${sessionId}`,
      });
    } catch (error) {
      return `Hermes sub-agent failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const resolved = resolveAgentTools(agent);
  const childCtx: AgentRunContext = {
    workspaceId: ctx.workspaceId,
    depth: ctx.depth + 1,
    visited: new Set([...ctx.visited, agentId]),
  };
  const tools = await buildAgentToolSet(resolved, childCtx, deps);
  const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills);
  const model = buildModel(agent.provider, agent.model);

  return deps.runModel({ model, system, prompt, tools, maxSteps: agent.maxSteps });
}
