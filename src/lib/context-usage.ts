export const CONTEXT_USAGE_PART = "data-context-usage";

export const CONTEXT_CATEGORIES = [
  "systemPrompt",
  "systemTools",
  "systemContext",
  "instructionFiles",
  "skills",
  "messages",
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export type ContextUsageSnapshot = {
  usedTokens: number;
  maxTokens: number;
  modelName: string;
  estimated: boolean;
  /** Estimated per-category split; `messages` is the remainder of `usedTokens`. */
  breakdown?: Record<ContextCategory, number>;
};

type MessageLike = {
  parts: readonly { type: string; data?: unknown }[];
};

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function parseContextBreakdown(
  value: unknown,
): Record<ContextCategory, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const breakdown = {} as Record<ContextCategory, number>;
  for (const category of CONTEXT_CATEGORIES) {
    const tokens = input[category];
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
      return null;
    breakdown[category] = Math.round(tokens);
  }
  return breakdown;
}

export function parseContextUsage(value: unknown): ContextUsageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const usedTokens = positiveNumber(input.usedTokens);
  const maxTokens = positiveNumber(input.maxTokens);
  const modelName =
    typeof input.modelName === "string" ? input.modelName.trim() : "";
  if (!usedTokens || !maxTokens || !modelName) return null;
  const breakdown = parseContextBreakdown(input.breakdown);
  return {
    usedTokens: Math.round(usedTokens),
    maxTokens: Math.round(maxTokens),
    modelName,
    estimated: input.estimated === true,
    ...(breakdown ? { breakdown } : {}),
  };
}

// ponytail: zero-dependency estimate; replace with provider tokenizers only if measured drift matters.
export function estimateContextTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  const cjk =
    text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) * 0.3);
}

export function resolveContextUsage(
  messages: readonly MessageLike[],
  fallback?: {
    maxTokens?: number | null;
    modelName?: string | null;
    context?: unknown;
    estimated?: boolean;
  },
): ContextUsageSnapshot | null {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const parts = messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== CONTEXT_USAGE_PART) continue;
      const usage = parseContextUsage(part.data);
      if (usage) return usage;
    }
  }

  const maxTokens = positiveNumber(fallback?.maxTokens);
  const modelName = fallback?.modelName?.trim();
  if (!messages.length || !maxTokens || !modelName) return null;
  const usedTokens = estimateContextTokens({
    messages,
    context: fallback?.context,
  });
  if (!usedTokens) return null;
  return {
    usedTokens,
    maxTokens: Math.round(maxTokens),
    modelName,
    estimated: fallback?.estimated !== false,
  };
}
