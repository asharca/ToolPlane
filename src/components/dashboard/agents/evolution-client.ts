"use client";

import type { EvolutionResponse } from "@/lib/agents/evolution/contracts";

export async function evolutionRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  onPage?: (nextCursor: string | null) => void,
): Promise<T> {
  const response = await fetch(url, {
    method,
    signal,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as EvolutionResponse<T> & {
    nextCursor?: string | null;
  };
  if ("error" in result) throw new Error(result.error.code);
  if (!response.ok || !("data" in result)) throw new Error("EVOLUTION_FAILED");
  onPage?.(result.nextCursor ?? null);
  return result.data;
}
