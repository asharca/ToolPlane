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

/** Missing limits predate their setting and take the default; invalid ones reject the policy. */
function fileLimits(policy: Record<string, unknown>): A2AFileLimits | null {
  const limits = { ...DEFAULT_A2A_FILE_LIMITS };
  for (const [key, [min, max]] of Object.entries(A2A_FILE_LIMIT_RANGES) as [
    keyof A2AFileLimits,
    readonly [number, number],
  ][]) {
    const value = policy[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      return null;
    limits[key] = value;
  }
  return limits;
}

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
      const limits = fileLimits(policy);
      if (
        limits &&
        typeof policy.allowHttp === "boolean" &&
        typeof policy.a2aInlineBytes === "number" &&
        Number.isSafeInteger(policy.a2aInlineBytes) &&
        policy.a2aInlineBytes >= MIN_A2A_INLINE_BYTES &&
        policy.a2aInlineBytes <= MAX_A2A_INLINE_BYTES
      )
        return {
          allowHttp: policy.allowHttp,
          a2aInlineBytes: policy.a2aInlineBytes,
          ...limits,
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
