import "server-only";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { z } from "zod";
import { SendMessageRequest, Task, Part, Role } from "@a2a-js/sdk";
import { db } from "@/lib/db";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { remoteChildGrant, remoteTarget } from "./remote-policy";
import { isRemoteGrant } from "./principal";
import type { TaskGrant } from "./principal";
import { LOCAL_OUTPUT_MODES } from "./model";
import { assertLocalRuntimeToken } from "./local-runtime";
import { childGrant, localTarget, LOCAL_LIMITS } from "./local-policy";
import {
  submitTask,
  getTask,
  requestCancellation,
  retryTaskFileReception,
} from "./store";
import { validateParams } from "./validation";
import { requestLocalInput, requestLocalWait } from "./local-continuation";
import { wakeAgentWorker } from "@/lib/agents/execution/worker";
import {
  collaborationPolicy,
  CollaborationApprovalRequiredError,
} from "./collaboration-policy";
import { LocalFileInput } from "@/lib/agents/execution/tool-inputs";
import { copyTaskFile, listTaskFiles, makeTaskFilePart } from "./files";
import type { TaskFile } from "./files";
import { stageLocalTaskFiles, storeSandboxTaskFile } from "./local-sandbox";

const Id = z.string().min(1).max(200);
const Empty = z.object({}).strict();
const Files = z.array(LocalFileInput).max(20).optional();
const Send = z
  .object({
    agentId: Id,
    request: z.record(z.string(), z.unknown()),
    files: Files,
  })
  .strict();
const RemoteSend = z
  .object({
    remoteAgentId: Id,
    request: z.record(z.string(), z.unknown()),
    files: Files,
  })
  .strict();
const Get = z.object({ taskId: Id }).strict();
const GetStatus = Get.extend({ retryFiles: z.boolean().optional() }).strict();
const Wait = z
  .object({ taskIds: z.array(Id).min(1).max(LOCAL_LIMITS.tasksPerRoot) })
  .strict();
const Input = z
  .object({ question: z.string().trim().min(1).max(4096) })
  .strict();
export async function executeLocalMcpTool(
  token: AgentRuntimeTokenPayload,
  name: string,
  raw: unknown,
  expectedTarget?: string,
) {
  const { row, grant, target } = await assertLocalRuntimeToken(token);
  const leaseToken = row.leaseToken;
  if (!leaseToken) throw new Error("Runtime task lease unavailable.");
  const attachFiles = async (
    request: SendMessageRequest,
    inputs: z.infer<typeof LocalFileInput>[] | undefined,
  ) => {
    if (!inputs?.length) return;
    if (!request.message) throw new Error("Message required.");
    for (const [index, source] of inputs.entries()) {
      const file = source.fileId
        ? (await listTaskFiles(row.id)).find(
            (file) => file.id === source.fileId,
          )
        : source.path
          ? await storeSandboxTaskFile(
              row,
              `delegation:${request.message.messageId}:${index}`,
              source.path,
              source.filename,
              source.mediaType,
            )
          : undefined;
      if (!file) throw new Error("Owned file unavailable.");
      request.message.parts.push(makeTaskFilePart(file));
    }
  };
  if (
    name === "a2a_list_remote_agents" &&
    !(await db.agent.count({
      where: {
        id: grant.agentId,
        workspaceId: grant.workspaceId,
        a2aOutboundEnabled: true,
      },
    }))
  ) {
    return { agents: [] };
  }
  try {
    switch (name) {
      case "a2a_list_remote_agents": {
        Empty.parse(raw);
        const candidates = await db.remoteA2AAgent.findMany({
          where: {
            workspaceId: grant.workspaceId,
            enabled: true,
            allowedAgentIds: { has: grant.agentId },
          },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
        const agents = [];
        for (const item of candidates) {
          try {
            await remoteTarget(
              db,
              grant.workspaceId,
              grant.agentId,
              item.id,
              row.id,
            );
            agents.push(item);
          } catch {
            /* Removed deployment approval is not a discoverable capability. */
          }
        }
        return { agents };
      }
      case "a2a_send_remote_message": {
        const input = RemoteSend.parse(raw);
        validateParams(
          "SendMessage",
          input.request,
          ["text/plain"],
          await getTransportSettings(),
        );
        const request = SendMessageRequest.fromJSON(input.request);
        if (request.tenant && request.tenant !== input.remoteAgentId)
          throw new Error("Wrong tenant");
        const authority = await remoteChildGrant(
          row.id,
          leaseToken,
          input.remoteAgentId,
        );
        await attachFiles(request, input.files);
        const result = await submitTask(authority, request, {
          parentLeaseToken: leaseToken,
        });
        wakeAgentWorker();
        return { task: Task.toJSON(Task.fromJSON(result.snapshot)) };
      }
      case "a2a_list_agents": {
        Empty.parse(raw);
        const agents = [];
        for (const id of target.targets.slice(0, 100)) {
          try {
            const agent = await localTarget(
              db,
              grant.workspaceId,
              id,
              "delegation",
            );
            const policy = await collaborationPolicy(
              db,
              grant.workspaceId,
              grant.agentId,
              "local",
              id,
              row.id,
            );
            if (
              agent.capabilityIds.some(
                (capability) => !policy.capabilityIds.includes(capability),
              )
            )
              continue;
            agents.push({ id: agent.id, name: agent.name });
          } catch {
            /* Unconfigured or unauthorized targets are not discoverable. */
          }
        }
        return { agents };
      }
      case "a2a_send_message": {
        const input = Send.parse(raw);
        validateParams(
          "SendMessage",
          input.request,
          LOCAL_OUTPUT_MODES,
          await getTransportSettings(),
        );
        const request = SendMessageRequest.fromJSON(input.request);
        if (request.tenant && request.tenant !== input.agentId)
          throw new Error("Wrong tenant");
        const authority = await childGrant(row.id, leaseToken, input.agentId);
        await attachFiles(request, input.files);
        const result = await submitTask(authority, request, {
          parentLeaseToken: leaseToken,
        });
        wakeAgentWorker();
        return { task: Task.toJSON(Task.fromJSON(result.snapshot)) };
      }
      case "a2a_get_task":
      case "a2a_cancel_task": {
        const { taskId, ...options } = (
          name === "a2a_get_task" ? GetStatus : Get
        ).parse(raw);
        const child = await db.a2ATask.findFirst({
          where: {
            id: taskId,
            parentTaskId: row.id,
            rootTaskId: row.rootTaskId,
          },
          include: { context: true },
        });
        if (!child) throw new Error("Child unavailable");
        const childIdentity = child.grant as unknown as TaskGrant;
        if (
          expectedTarget !== undefined &&
          expectedTarget !==
            (isRemoteGrant(childIdentity)
              ? `remote:${child.context.remoteAgentId}`
              : `agent:${child.context.agentId}`)
        )
          throw new Error("Child unavailable");
        const authority =
          isRemoteGrant(childIdentity) && child.context.remoteAgentId
            ? await remoteChildGrant(
                row.id,
                leaseToken,
                child.context.remoteAgentId,
              )
            : child.context.agentId
              ? await childGrant(row.id, leaseToken, child.context.agentId)
              : null;
        if (
          !authority ||
          (isRemoteGrant(authority) &&
            child.context.targetBinding !== authority.targetBinding)
        )
          throw new Error("Child unavailable");
        if ("retryFiles" in options && options.retryFiles)
          await retryTaskFileReception(authority, { taskId });
        const task =
          name === "a2a_cancel_task"
            ? await requestCancellation(authority, taskId)
            : await getTask(authority, taskId);
        if (name === "a2a_cancel_task") {
          wakeAgentWorker();
          return { task: Task.toJSON(task) };
        }
        const received = await receiveChildFiles(row.id, child.id, task);
        const files = received.length
          ? (await stageLocalTaskFiles(row)).filter((file) =>
              received.includes(file.fileId),
            )
          : [];
        return { task: Task.toJSON(task), ...(files.length ? { files } : {}) };
      }
      case "a2a_await_tasks":
        return requestLocalWait(row.id, leaseToken, Wait.parse(raw).taskIds);
      case "a2a_request_input":
        return requestLocalInput(row.id, leaseToken, Input.parse(raw).question);
      default:
        throw new Error("Unknown collaboration tool");
    }
  } catch (error) {
    if (
      error instanceof CollaborationApprovalRequiredError &&
      (name === "a2a_send_message" || name === "a2a_send_remote_message")
    ) {
      const waiting = await requestLocalInput(
        row.id,
        leaseToken,
        `${error.message} Choose an already approved target or ask a workspace administrator to approve policy for a new task. A reply cannot grant permissions.`,
      );
      return { ...waiting, approvalRequired: true };
    }
    throw error;
  }
}

/** Copy ready child output files to parent-owned handles; unready handles never leak. */
async function receiveChildFiles(
  parentId: string,
  childId: string,
  task: Task,
) {
  const received: string[] = [];
  const copiedFiles = new Map<string, TaskFile>();
  const readyFiles = new Set(
    (await listTaskFiles(childId)).map((file) => file.id),
  );
  const delivery = task.metadata?.toolplaneFileDelivery;
  const unavailableState =
    delivery &&
    typeof delivery === "object" &&
    "state" in delivery &&
    delivery.state === "failed"
      ? "failed"
      : "pending";
  const outputParts = [
    ...task.artifacts.map((artifact) => artifact.parts),
    ...task.history
      .filter((message) => message.role === Role.ROLE_AGENT)
      .map((message) => message.parts),
    ...(task.status?.message ? [task.status.message.parts] : []),
  ];
  for (const parts of outputParts) {
    for (const [index, part] of parts.entries()) {
      const json = Part.toJSON(part) as {
        metadata?: { toolplaneFileId?: unknown };
      };
      const fileId = json.metadata?.toolplaneFileId;
      if (typeof fileId !== "string") continue;
      if (!readyFiles.has(fileId)) {
        // A child-owned intake handle is not usable by the parent. Keep
        // status/delivery metadata visible without advertising a handle
        // or sandbox path until immutable bytes are actually available.
        parts[index] = Part.fromJSON({
          data: { toolplaneFileDelivery: { state: unavailableState } },
          metadata: { toolplaneFileDelivery: { state: unavailableState } },
          filename: part.filename,
          mediaType: part.mediaType,
        });
        continue;
      }
      const file =
        copiedFiles.get(fileId) ??
        (await copyTaskFile(
          childId,
          fileId,
          parentId,
          `child:${childId}:${fileId}`,
        ));
      copiedFiles.set(fileId, file);
      parts[index] = makeTaskFilePart(file);
      received.push(file.id);
    }
  }
  return received;
}
