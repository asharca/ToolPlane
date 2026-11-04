import "server-only";
import { db } from "@/lib/db";
import {
  DEFAULT_TRANSPORT_POLICY,
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  type TransportPolicy,
} from "@/lib/transport-policy";

export const TRANSPORT_SETTINGS_KEY = "transport.policy";
export type TransportSettings = TransportPolicy & {
  source: "database" | "default";
};

export async function getTransportSettings(): Promise<TransportSettings> {
  const row = await db.systemSetting.findUnique({
    where: { key: TRANSPORT_SETTINGS_KEY },
    select: { value: true },
  });
  if (!row) return { ...DEFAULT_TRANSPORT_POLICY, source: "default" };
  try {
    const value: unknown = JSON.parse(row.value);
    if (value && typeof value === "object") {
      const policy = value as Record<string, unknown>;
      if (
        typeof policy.allowHttp === "boolean" &&
        typeof policy.a2aInlineBytes === "number" &&
        Number.isSafeInteger(policy.a2aInlineBytes) &&
        policy.a2aInlineBytes >= MIN_A2A_INLINE_BYTES &&
        policy.a2aInlineBytes <= MAX_A2A_INLINE_BYTES
      )
        return {
          allowHttp: policy.allowHttp,
          a2aInlineBytes: policy.a2aInlineBytes,
          source: "database",
        };
    }
  } catch {
    // Malformed persisted policy must never enable plaintext transport.
  }
  return { ...DEFAULT_TRANSPORT_POLICY, source: "database" };
}
