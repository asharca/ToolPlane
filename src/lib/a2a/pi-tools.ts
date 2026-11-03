import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { db } from "@/lib/db";
import { PI_SUBMIT_WAIT_MS, PiCommunicationInputs } from "./pi-tool-catalog";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { executeLocalMcpTool } from "./local-mcp-tools";
import { updateTaskUi } from "@/lib/agents/execution/task-ui";
import { NativeUiProjectionLimitError } from "@/lib/agents/execution/native-ui";

const POLL_MS = 1_000;
const ACTIVE_STATES: readonly number[] = [
  TaskState.TASK_STATE_SUBMITTED,
  TaskState.TASK_STATE_WORKING,
];
const ACTIVITY_OUTPUT_CHARACTERS = 20_000;

/** True once the child leaves submitted/working; false on wait budget or abort. */
async function waitForChild(taskId: string, signal?: AbortSignal) {
  const deadline = Date.now() + PI_SUBMIT_WAIT_MS;
  for (;;) {
    const row = await db.a2ATask.findUnique({
      where: { id: taskId },
      select: { state: true },
    });
    if (!row || !ACTIVE_STATES.includes(row.state)) return true;
    if (Date.now() >= deadline || signal?.aborted) return false;
    await sleep(POLL_MS, undefined, { signal }).catch(() => undefined);
  }
}

function taskText(task: Task) {
  return [
    ...task.artifacts.flatMap((artifact) => artifact.parts),
    ...(task.status?.message?.parts ?? []),
  ]
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : [],
    )
    .join("\n")
    .slice(0, ACTIVITY_OUTPUT_CHARACTERS);
}

async function targetName(token: AgentRuntimeTokenPayload, target: string) {
  const [kind, id] = target.split(":");
  const row =
    kind === "agent"
      ? await db.agent.findFirst({
          where: { id, workspaceId: token.workspaceId },
          select: { name: true },
        })
      : await db.remoteA2AAgent.findFirst({
          where: { id, workspaceId: token.workspaceId },
          select: { name: true },
        });
  return row?.name;
}

/** Platform children share the parent's sub-agent activity view with native children. */
async function recordChildActivity(
  token: AgentRuntimeTokenPayload,
  target: string,
  taskId: string,
  detail: { message: string } | { task: Task },
) {
  const state = "task" in detail ? detail.task.status?.state : undefined;
  const subagentName = await targetName(token, target);
  try {
    await updateTaskUi(token, {
      action: "activity",
      activity: {
        type: "tool",
        toolName: "pi_a2a_submit",
        toolCallId: `platform-child:${taskId}`,
        source: {
          subagentId: taskId,
          ...(subagentName ? { subagentName } : {}),
        },
        ...("message" in detail
          ? {
              status: "running" as const,
              input: { target, message: detail.message },
            }
          : {
              status:
                state === TaskState.TASK_STATE_COMPLETED
                  ? ("completed" as const)
                  : state !== undefined &&
                      !ACTIVE_STATES.includes(state) &&
                      state !== TaskState.TASK_STATE_INPUT_REQUIRED
                    ? ("failed" as const)
                    : ("running" as const),
              output: taskText(detail.task),
            }),
      },
    });
  } catch (error) {
    // Display storage exhaustion must not hide the delegated result from the model.
    if (!(error instanceof NativeUiProjectionLimitError)) throw error;
  }
}

async function childStatus(
  token: AgentRuntimeTokenPayload,
  target: string,
  taskId: string,
  retryFiles?: boolean,
) {
  const result = (await executeLocalMcpTool(
    token,
    "a2a_get_task",
    { taskId, ...(retryFiles !== undefined ? { retryFiles } : {}) },
    target,
  )) as { task: unknown; files?: unknown };
  const task = Task.fromJSON(result.task);
  if (
    !ACTIVE_STATES.includes(task.status?.state ?? TaskState.TASK_STATE_WORKING)
  )
    await recordChildActivity(token, target, taskId, { task });
  return result;
}

export async function executePiCommunicationTool(
  token: AgentRuntimeTokenPayload,
  name: string,
  raw: unknown,
  signal?: AbortSignal,
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
            acceptedOutputModes: ["*/*"],
            historyLength: 0,
          },
        }),
      );
      const result = (await executeLocalMcpTool(
        token,
        kind === "agent" ? "a2a_send_message" : "a2a_send_remote_message",
        {
          [kind === "agent" ? "agentId" : "remoteAgentId"]: id,
          request,
          ...(input.files ? { files: input.files } : {}),
        },
      )) as {
        task?: unknown;
        approvalRequired?: boolean;
        instruction?: string;
      };
      if (result.approvalRequired) return result;
      const taskId = Task.fromJSON(result.task).id;
      await recordChildActivity(token, input.target, taskId, {
        message: input.message,
      });
      if (input.wait === false) return { taskId, pending: true };
      if (!(await waitForChild(taskId, signal)))
        return {
          taskId,
          pending: true,
          instruction:
            "The child is still running. Continue other work or call pi_a2a_status with this taskId later.",
        };
      return { taskId, ...(await childStatus(token, input.target, taskId)) };
    }
    case "pi_a2a_status": {
      const input = PiCommunicationInputs.status.parse(raw);
      return childStatus(token, input.target, input.taskId, input.retryFiles);
    }
    case "pi_a2a_cancel": {
      const input = PiCommunicationInputs.child.parse(raw);
      return executeLocalMcpTool(
        token,
        "a2a_cancel_task",
        { taskId: input.taskId },
        input.target,
      );
    }
    default:
      throw new Error("Unknown communication tool");
  }
}
