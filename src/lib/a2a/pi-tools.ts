import "server-only";
import { SendMessageRequest, Task } from "@a2a-js/sdk";
import { PiCommunicationInputs } from "./pi-tool-catalog";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { executeLocalMcpTool } from "./local-mcp-tools";

export async function executePiCommunicationTool(
  token: AgentRuntimeTokenPayload,
  name: string,
  raw: unknown,
): Promise<unknown> {
  switch (name) {
    case "pi_a2a_peers": {
      PiCommunicationInputs.peers.parse(raw);
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
      const input = PiCommunicationInputs.submit.parse(raw);
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
      )) as {
        task?: unknown;
        approvalRequired?: boolean;
        instruction?: string;
      };
      if (result.approvalRequired) return result;
      return { taskId: Task.fromJSON(result.task).id };
    }
    case "pi_a2a_status":
    case "pi_a2a_cancel": {
      const input = PiCommunicationInputs.child.parse(raw);
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
