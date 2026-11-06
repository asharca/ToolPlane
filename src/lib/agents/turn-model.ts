import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AgentModelOverrideSchema, type AgentModelOverride } from "./chat-body";
import {
  AgentConfigurationError,
  validateNativeModelSelection,
} from "./mutations";

export class AgentModelOverrideError extends Error {
  readonly status = 400;
  constructor(
    readonly code: "modelOverrideInvalid" | "modelOverrideUnavailable",
  ) {
    super(code);
  }
}

/** Same workspace/catalog/runtime constraints as Agent settings, plus usable credentials. */
export async function resolveAgentModelOverride(
  workspaceId: string,
  override: AgentModelOverride,
  runtimeKind: string,
  tx?: Prisma.TransactionClient,
) {
  const parsed = AgentModelOverrideSchema.safeParse(override);
  if (!parsed.success)
    throw new AgentModelOverrideError("modelOverrideInvalid");
  const resolve = async (client: Prisma.TransactionClient) => {
    try {
      const id = await validateNativeModelSelection(
        client,
        workspaceId,
        runtimeKind,
        parsed.data.providerId,
        parsed.data.model,
      );
      if (!id) throw new AgentModelOverrideError("modelOverrideUnavailable");
      const provider = await client.modelProvider.findFirst({
        where: { id, workspaceId },
      });
      if (!provider?.apiKey.trim())
        throw new AgentModelOverrideError("modelOverrideUnavailable");
      return { provider, model: parsed.data.model };
    } catch (error) {
      if (!(error instanceof AgentConfigurationError)) throw error;
      // Never return provider configuration or credentials in validation errors.
      throw new AgentModelOverrideError("modelOverrideUnavailable");
    }
  };
  return tx ? resolve(tx) : db.$transaction(resolve);
}

/** Persisted channel selection is authoritative, but is revalidated for every turn. */
export function conversationModelOverride(
  value: unknown,
): AgentModelOverride | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("MODEL_OVERRIDE_UNAVAILABLE");
  const candidate = value as Record<string, unknown>;
  const parsed = AgentModelOverrideSchema.safeParse({
    providerId: candidate.providerId,
    model: candidate.model,
  });
  if (!parsed.success) throw new Error("MODEL_OVERRIDE_UNAVAILABLE");
  return parsed.data;
}

export async function resolveConversationModelOverride(
  workspaceId: string,
  value: unknown,
  runtimeKind: string,
  tx?: Prisma.TransactionClient,
) {
  const override = conversationModelOverride(value);
  if (!override) return undefined;
  try {
    return {
      ...(await resolveAgentModelOverride(
        workspaceId,
        override,
        runtimeKind,
        tx,
      )),
      override,
    };
  } catch {
    throw new Error("MODEL_OVERRIDE_UNAVAILABLE");
  }
}

export const AGENT_MODEL_OVERRIDE_PART = "data-agent-model-override";
export const AGENT_TURN_MODEL_PART = "data-agent-turn-model";

/** Only server-authored user parts are read; composer history cannot choose a model. */
export function agentMessageModelOverride(
  parts: unknown,
): AgentModelOverride | undefined {
  if (!Array.isArray(parts)) return undefined;
  const part = parts.find((part) => part?.type === AGENT_MODEL_OVERRIDE_PART);
  if (!part) return undefined;
  const parsed = AgentModelOverrideSchema.safeParse(part.data);
  if (!parsed.success)
    throw new AgentModelOverrideError("modelOverrideInvalid");
  return parsed.data;
}
