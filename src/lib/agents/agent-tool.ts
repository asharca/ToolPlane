import type { Tool } from "@earendil-works/pi-ai";

export type AgentTool = Tool & {
  execute(args: Record<string, unknown>, ...rest: unknown[]): Promise<unknown>;
  toolplaneOrigin?: { deploymentId: string; originalToolName: string };
};

export type AgentToolSet = Record<string, AgentTool>;

export function agentTool(input: AgentTool): AgentTool {
  return input;
}

export function jsonSchema(schema: Record<string, unknown>) {
  return schema;
}
