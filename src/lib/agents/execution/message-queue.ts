import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";

export type QueuedAgentMessage = {
  id: string;
  mode: "steer" | "follow_up";
  text: string;
};
export type AgentMessageQueue = {
  messages: QueuedAgentMessage[];
  pendingMessageCount: number;
};
export type QueueResult = {
  disposition: "queued" | "handled" | "cleared";
  queue: AgentMessageQueue;
};
export class AgentMessageQueueError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export type QueueControl = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  taskId: string;
  actorId: string;
  channelId?: string;
  sessionKey?: string | null;
  authorize: () => Promise<void>;
  send: (
    message: (QueuedAgentMessage & { deduplicate?: boolean }) | null,
  ) => Promise<QueueResult>;
};
const globalQueue = globalThis as typeof globalThis & {
  __agentMessageQueues?: Map<string, QueueControl>;
};
globalQueue.__agentMessageQueues ??= new Map();
const controls = globalQueue.__agentMessageQueues;

export function registerAgentMessageQueue(control: QueueControl) {
  controls.set(control.conversationId, control);
  return () => {
    if (controls.get(control.conversationId) === control)
      controls.delete(control.conversationId);
  };
}

export async function updateAgentMessageQueue(input: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  actorId: string;
  message: Omit<QueuedAgentMessage, "id"> | null;
}) {
  assertRuntimeOwner();
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    select: {
      legacyRevisionUnresolved: true,
      agentRevisionId: true,
      agent: { select: { runtimeKind: true } },
    },
  });
  if (!conversation)
    throw new AgentMessageQueueError("CONVERSATION_NOT_FOUND", 404);
  if (
    conversation.legacyRevisionUnresolved ||
    !conversation.agentRevisionId ||
    conversation.agent.runtimeKind !== "pi-sdk"
  )
    throw new AgentMessageQueueError("CONVERSATION_READ_ONLY", 410);
  const control = controls.get(input.conversationId);
  if (
    !control ||
    control.agentId !== input.agentId ||
    control.workspaceId !== input.workspaceId
  )
    throw new AgentMessageQueueError("AGENT_QUEUE_NOT_RUNNING");
  if (control.actorId !== input.actorId)
    throw new AgentMessageQueueError("AGENT_QUEUE_FORBIDDEN", 403);
  return control.send(
    input.message ? { ...input.message, id: randomUUID() } : null,
  );
}

/** The durable channel ingress remains the fallback if this exact round has ended. */
export function runningChannelMessageQueue(input: {
  workspaceId: string;
  agentId: string;
  channelId: string;
  sessionKey: string;
  actorId: string;
  conversationId?: string;
}) {
  return [...controls.values()].find(
    (control) =>
      control.workspaceId === input.workspaceId &&
      control.agentId === input.agentId &&
      control.channelId === input.channelId &&
      control.actorId === input.actorId &&
      control.sessionKey === input.sessionKey &&
      (!input.conversationId ||
        control.conversationId === input.conversationId),
  );
}
