import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { AgentPromptInvocation } from "./sandbox-runtime";

export const AGENT_PROMPT_INVOCATION_PART = "data-agent-prompt-invocation";
export type AgentPromptInvocationPart = {
  type: typeof AGENT_PROMPT_INVOCATION_PART;
  data: AgentPromptInvocation;
};

/** Native expansion is authoritative; record it without rewriting or expanding user text again. */
export async function persistAgentPromptInvocation(input: {
  conversationId: string;
  messageId: string;
  invocation: AgentPromptInvocation;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ parts: Prisma.JsonValue }>>`
      SELECT "parts" FROM "Message"
      WHERE "id" = ${input.messageId} AND "conversationId" = ${input.conversationId} AND "role" = 'user'
      FOR UPDATE
    `;
    if (!rows[0] || !Array.isArray(rows[0].parts))
      throw new Error("Prompt invocation user message is unavailable.");
    const parts = rows[0].parts.filter(
      (part) =>
        !(
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          part.type === AGENT_PROMPT_INVOCATION_PART
        ),
    );
    const part: AgentPromptInvocationPart = {
      type: AGENT_PROMPT_INVOCATION_PART,
      data: input.invocation,
    };
    await tx.message.update({
      where: { id: input.messageId },
      data: { parts: [...parts, part] as Prisma.InputJsonValue },
    });
  });
}
