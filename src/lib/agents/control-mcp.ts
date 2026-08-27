import 'server-only';
import { z } from 'zod';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import {
  AgentControlError,
  createAgentFromControl,
  getAgentControlAgent,
  inspectAgentControlDeployment,
  listAgentControlAgents,
  listAgentControlResources,
  sendAgentControlMessage,
} from '@/lib/agents/control-service';

export type AgentControlContext = {
  workspaceId: string;
  workspaceSlug: string;
};

const Id = z.string().trim().min(1).max(128);
const IdList = z.array(Id).max(100).transform((ids) => [...new Set(ids)]);
const EmptyArguments = z.object({}).strict();
const AgentIdArguments = z.object({ agentId: Id }).strict();
const DeploymentIdArguments = z.object({ deploymentId: Id }).strict();
const SendMessageArguments = z.object({
  agentId: Id,
  message: z.string().trim().min(1).max(20_000),
  conversationId: Id.optional(),
}).strict();
const CreateAgentArguments = z.object({
  name: z.string().trim().min(1).max(60),
  runtime: z.enum(['pi', 'hermes']),
  systemPrompt: z.string().trim().max(100_000).nullable().optional(),
  providerId: Id.nullable().optional(),
  providerIds: IdList.default([]),
  model: z.string().trim().min(1).max(240).nullable().optional(),
  maxSteps: z.number().int().min(AGENT_STEP_BOUNDS.min).max(AGENT_STEP_BOUNDS.max)
    .default(AGENT_STEP_BOUNDS.default),
  deploymentIds: IdList.default([]),
  installedSkillIds: IdList.default([]),
  toolkitIds: IdList.default([]),
  sandboxIds: IdList.default([]),
  subAgentIds: IdList.default([]),
}).strict().superRefine((input, ctx) => {
  if (input.runtime === 'pi') {
    if (input.providerIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerIds'],
        message: 'Pi agents use providerId, not providerIds.',
      });
    }
    if (input.model && !input.providerId) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'A model requires providerId.',
      });
    }
  } else {
    for (const [key, value] of [
      ['providerId', input.providerId],
      ['model', input.model],
      ['systemPrompt', input.systemPrompt],
    ] as const) {
      if (value) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Hermes agents do not accept ${key}.`,
        });
      }
    }
  }
});

export const AGENT_CONTROL_MCP_TOOLS = [
  {
    name: 'list_agent_resources',
    description: 'List safe, workspace-owned model providers, MCP deployments, skills, toolkits, and sandboxes. Call this before create_agent to discover valid IDs. Secrets are never returned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'inspect_mcp_deployment',
    description: 'Inspect the AI-exposed tools of one running MCP deployment before attaching it to an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        deploymentId: { type: 'string', description: 'Workspace MCP deployment ID.' },
      },
      required: ['deploymentId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'list_agents',
    description: 'List agents in this workspace, including configuration readiness and resource counts. Agent IDs can be used as subAgentIds when creating another agent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_agent',
    description: 'Get one agent\'s safe configuration, bindings, runtime state, and console path. Provider API keys and runtime environment values are never returned.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Workspace agent ID.' } },
      required: ['agentId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'create_agent',
    description: 'Create and fully configure a ToolPlane agent atomically from existing workspace resources. Pi agents use providerId/model/systemPrompt. Hermes agents use providerIds and the instance-approved runtime image. Omit model configuration to create a draft. This call is non-idempotent; after an uncertain timeout, call list_agents before retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60 },
        runtime: { type: 'string', enum: ['pi', 'hermes'] },
        systemPrompt: { type: ['string', 'null'], maxLength: 100000 },
        providerId: { type: ['string', 'null'], description: 'Pi model provider ID.' },
        providerIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 100,
          description: 'Hermes model provider IDs.',
        },
        model: { type: ['string', 'null'], description: 'Pi model ID.' },
        maxSteps: {
          type: 'integer',
          minimum: AGENT_STEP_BOUNDS.min,
          maximum: AGENT_STEP_BOUNDS.max,
          default: AGENT_STEP_BOUNDS.default,
        },
        deploymentIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        installedSkillIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        toolkitIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        sandboxIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        subAgentIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      },
      required: ['name', 'runtime'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'send_message_to_agent',
    description: 'Run an existing agent and persist the exchange. Omit conversationId to start a conversation; pass the returned conversationId to continue it.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Workspace agent ID.' },
        message: { type: 'string', minLength: 1, maxLength: 20000 },
        conversationId: { type: 'string', description: 'Optional conversation ID returned by a prior call.' },
      },
      required: ['agentId', 'message'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      // The agent may invoke attached tools with side effects, so clients
      // should treat messaging as potentially destructive.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
] as const;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
}

function parseArguments<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AgentControlError('invalid_arguments', validationMessage(parsed.error));
  }
  return parsed.data;
}

export function isAgentControlTool(name: string): boolean {
  return AGENT_CONTROL_MCP_TOOLS.some((tool) => tool.name === name);
}

export async function executeAgentControlTool(
  context: AgentControlContext,
  name: string,
  rawArguments: unknown,
) {
  switch (name) {
    case 'list_agent_resources':
      parseArguments(EmptyArguments, rawArguments);
      return listAgentControlResources(context.workspaceId);
    case 'inspect_mcp_deployment': {
      const input = parseArguments(DeploymentIdArguments, rawArguments);
      return inspectAgentControlDeployment(context.workspaceId, input.deploymentId);
    }
    case 'list_agents':
      parseArguments(EmptyArguments, rawArguments);
      return listAgentControlAgents(context.workspaceId);
    case 'get_agent': {
      const input = parseArguments(AgentIdArguments, rawArguments);
      return getAgentControlAgent(context.workspaceId, context.workspaceSlug, input.agentId);
    }
    case 'create_agent': {
      const input = parseArguments(CreateAgentArguments, rawArguments);
      return createAgentFromControl(context.workspaceId, context.workspaceSlug, input);
    }
    case 'send_message_to_agent': {
      const input = parseArguments(SendMessageArguments, rawArguments);
      return sendAgentControlMessage(context.workspaceId, input);
    }
    default:
      throw new AgentControlError('not_found', `Unknown tool: ${name}`);
  }
}
