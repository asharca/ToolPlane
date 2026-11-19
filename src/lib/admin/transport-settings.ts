import "server-only";
import { db } from "@/lib/db";
import {
  A2A_FILE_LIMIT_RANGES,
  DEFAULT_A2A_FILE_LIMITS,
  DEFAULT_TRANSPORT_POLICY,
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  type A2AFileLimits,
  type TransportPolicy,
} from "@/lib/transport-policy";

export const TRANSPORT_SETTINGS_KEY = "transport.policy";
export type TransportSettings = TransportPolicy &
  A2AFileLimits & {
    source: "database" | "default";
  };

const [minTaskFiles, maxTaskFiles] = A2A_FILE_LIMIT_RANGES.a2aTaskFiles;

export async function getTransportSettings(): Promise<TransportSettings> {
  const row = await db.systemSetting.findUnique({
    where: { key: TRANSPORT_SETTINGS_KEY },
    select: { value: true },
  });
  if (!row)
    return {
      ...DEFAULT_TRANSPORT_POLICY,
      ...DEFAULT_A2A_FILE_LIMITS,
      source: "default",
    };
  try {
    const value: unknown = JSON.parse(row.value);
    if (value && typeof value === "object") {
      const policy = value as Record<string, unknown>;
      const a2aTaskFiles =
        policy.a2aTaskFiles === undefined
          ? DEFAULT_A2A_FILE_LIMITS.a2aTaskFiles
          : policy.a2aTaskFiles;
      if (
        typeof a2aTaskFiles === "number" &&
        Number.isSafeInteger(a2aTaskFiles) &&
        a2aTaskFiles >= minTaskFiles &&
        a2aTaskFiles <= maxTaskFiles &&
        typeof policy.allowHttp === "boolean" &&
        typeof policy.a2aInlineBytes === "number" &&
        Number.isSafeInteger(policy.a2aInlineBytes) &&
        policy.a2aInlineBytes >= MIN_A2A_INLINE_BYTES &&
        policy.a2aInlineBytes <= MAX_A2A_INLINE_BYTES
      )
        return {
          allowHttp: policy.allowHttp,
          a2aInlineBytes: policy.a2aInlineBytes,
          a2aTaskFiles,
          source: "database",
        };
    }
  } catch {
    // Malformed persisted policy must never enable plaintext transport.
  }
  return {
    ...DEFAULT_TRANSPORT_POLICY,
    ...DEFAULT_A2A_FILE_LIMITS,
    source: "database",
  };
}
