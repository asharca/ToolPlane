import "server-only";
import { SendMessageRequest, Task } from "@a2a-js/sdk";
import { z } from "zod";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { A2A_LIMITS } from "./model";
import { executeLocalMcpTool } from "./local-mcp-tools";

const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const Target = z.string().regex(/^(agent|remote):[A-Za-z0-9_-]{1,200}$/);
const Empty = z.object({}).strict();
const Submit = z
  .object({
    target: Target,
    message: z.string().min(1).max(A2A_LIMITS.inputCharacters),
    messageId: Id,
  })
  .strict();
const Child = z.object({ target: Target, taskId: Id }).strict();

/** Private MCP transport; the Harness exposes only its four canonical model tools. */
export const piCommunicationCatalog = [
  {
    name: "pi_a2a_peers",
    description:
      "List authorized internal and registered external Agent targets.",
    schema: Empty,
  },
  {
    name: "pi_a2a_submit",
    description:
      "Submit one idempotent delegation and return its public platform task ID.",
    schema: Submit,
  },
  {
    name: "pi_a2a_status",
    description: "Read a direct child task belonging to the specified target.",
    schema: Child,
  },
  {
    name: "pi_a2a_cancel",
    description:
      "Request child cancellation; stopping must still be confirmed.",
    schema: Child,
  },
] as const;

export async function executePiCommunicationTool(
  token: AgentRuntimeTokenPayload,
  name: string,
  raw: unknown,
): Promise<unknown> {
  switch (name) {
    case "pi_a2a_peers": {
      Empty.parse(raw);
      const local = (await executeLocalMcpTool(
        token,
        "a2a_list_agents",
        {},
      )) as { agents: { id: string; name: string }[] };
      const remote = (await executeLocalMcpTool(
        token,
        "a2a_list_remote_agents",
        {},
      )) as { agents: { id: string; name: string }[] };
      return {
        peers: [
          ...local.agents.map(({ id, name }) => ({
            target: `agent:${id}`,
            name,
          })),
          ...remote.agents.map(({ id, name }) => ({
            target: `remote:${id}`,
            name,
          })),
        ],
      };
    }
    case "pi_a2a_submit": {
      const input = Submit.parse(raw);
      const [kind, id] = input.target.split(":");
      const request = SendMessageRequest.toJSON(
        SendMessageRequest.fromJSON({
          message: {
            messageId: input.messageId,
            role: "ROLE_USER",
            parts: [{ text: input.message, mediaType: "text/plain" }],
          },
          configuration: {
            returnImmediately: true,
            acceptedOutputModes: ["text/plain"],
            historyLength: 0,
          },
        }),
      );
      const result = (await executeLocalMcpTool(
        token,
        kind === "agent" ? "a2a_send_message" : "a2a_send_remote_message",
        { [kind === "agent" ? "agentId" : "remoteAgentId"]: id, request },
      )) as { task: unknown };
      return { taskId: Task.fromJSON(result.task).id };
    }
    case "pi_a2a_status":
    case "pi_a2a_cancel": {
      const input = Child.parse(raw);
      return executeLocalMcpTool(
        token,
        name === "pi_a2a_status" ? "a2a_get_task" : "a2a_cancel_task",
        { taskId: input.taskId },
        input.target,
      );
    }
    default:
      throw new Error("Unknown communication tool");
  }
}
