import "server-only";
import { db } from "@/lib/db";
import {
  DEFAULT_TRANSPORT_POLICY,
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  DEFAULT_A2A_FILE_BYTES,
  MIN_A2A_FILE_BYTES,
  MAX_A2A_FILE_BYTES,
  type TransportPolicy,
} from "@/lib/transport-policy";

export const TRANSPORT_SETTINGS_KEY = "transport.policy";
export type TransportSettings = TransportPolicy & {
  a2aFileBytes: number;
  source: "database" | "default";
};

export async function getTransportSettings(): Promise<TransportSettings> {
  const row = await db.systemSetting.findUnique({
    where: { key: TRANSPORT_SETTINGS_KEY },
    select: { value: true },
  });
  if (!row)
    return {
      ...DEFAULT_TRANSPORT_POLICY,
      a2aFileBytes: DEFAULT_A2A_FILE_BYTES,
      source: "default",
    };
  try {
    const value: unknown = JSON.parse(row.value);
    if (value && typeof value === "object") {
      const policy = value as Record<string, unknown>;
      const fileBytes =
        policy.a2aFileBytes === undefined
          ? DEFAULT_A2A_FILE_BYTES
          : policy.a2aFileBytes;
      if (
        typeof policy.allowHttp === "boolean" &&
        typeof policy.a2aInlineBytes === "number" &&
        Number.isSafeInteger(policy.a2aInlineBytes) &&
        policy.a2aInlineBytes >= MIN_A2A_INLINE_BYTES &&
        policy.a2aInlineBytes <= MAX_A2A_INLINE_BYTES &&
        typeof fileBytes === "number" &&
        Number.isSafeInteger(fileBytes) &&
        fileBytes >= MIN_A2A_FILE_BYTES &&
        fileBytes <= MAX_A2A_FILE_BYTES
      )
        return {
          allowHttp: policy.allowHttp,
          a2aInlineBytes: policy.a2aInlineBytes,
          a2aFileBytes: fileBytes,
          source: "database",
        };
    }
  } catch {
    // Malformed persisted policy must never enable plaintext transport.
  }
  return {
    ...DEFAULT_TRANSPORT_POLICY,
    a2aFileBytes: DEFAULT_A2A_FILE_BYTES,
    source: "database",
  };
}
