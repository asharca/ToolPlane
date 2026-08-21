import { Type, type Tool, type TSchema } from '@earendil-works/pi-ai';

export type AgentTool = Tool & {
  execute(args: Record<string, unknown>, ...rest: unknown[]): Promise<unknown>;
};

export type AgentToolSet = Record<string, AgentTool>;

export function agentTool(input: AgentTool): AgentTool {
  return input;
}

export function jsonSchema(schema: Record<string, unknown>): TSchema {
  return Type.Unsafe<Record<string, unknown>>(schema as TSchema);
}
