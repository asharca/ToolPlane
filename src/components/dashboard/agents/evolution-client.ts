"use client";

import {
  evolutionFailures,
  type EvolutionErrorCode,
} from "@/lib/agents/evolution/contracts";
import { apiRequest } from "@/lib/client/api";

/** A failed evolution call; only its registered code reaches the UI. */
export class EvolutionRequestError extends Error {
  constructor(readonly code: EvolutionErrorCode) {
    super(code);
  }
}

export function evolutionErrorCode(cause: unknown): EvolutionErrorCode {
  return cause instanceof EvolutionRequestError
    ? cause.code
    : "EVOLUTION_FAILED";
}

export async function evolutionRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  onPage?: (nextCursor: string | null) => void,
): Promise<T> {
  const result = await apiRequest<{ data?: T; nextCursor?: string | null }>(
    url,
    { method, signal, json: body },
  );
  if (!result.ok)
    throw new EvolutionRequestError(
      evolutionFailures.is(result.code) ? result.code : "EVOLUTION_FAILED",
    );
  if (!result.data || !("data" in result.data))
    throw new EvolutionRequestError("EVOLUTION_FAILED");
  onPage?.(result.data.nextCursor ?? null);
  return result.data.data as T;
}
