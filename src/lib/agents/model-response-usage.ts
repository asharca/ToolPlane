import "server-only";
import type { RuntimeUsage } from "./runtime-commands";

const MAX_USAGE_FRAME = 256 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;

/** Observe only usage frames; never retain an entire model response or tee its stream. */
export class ModelResponseUsage {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private oversized = false;
  private current: RuntimeUsage | undefined;

  constructor(private readonly sse: boolean) {}

  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.oversized) return;
      if (this.pending.length + text.length > MAX_USAGE_FRAME) {
        this.pending = "";
        this.oversized = true;
      } else this.pending += text;
      return;
    }
    let start = 0;
    for (
      let end = text.indexOf("\n");
      end !== -1;
      end = text.indexOf("\n", start)
    ) {
      this.append(text.slice(start, end));
      if (!this.oversized) this.parseLine(this.pending);
      this.pending = "";
      this.oversized = false;
      start = end + 1;
    }
    this.append(text.slice(start));
  }

  finish(): RuntimeUsage | undefined {
    if (!this.oversized) {
      if (this.sse) this.parseLine(this.pending);
      else this.parseJson(this.pending);
    }
    this.pending = "";
    return this.current;
  }

  private append(text: string) {
    if (this.oversized) return;
    if (this.pending.length + text.length > MAX_USAGE_FRAME) {
      this.pending = "";
      this.oversized = true;
    } else this.pending += text;
  }

  private parseLine(line: string) {
    if (line.startsWith("data:")) this.parseJson(line.slice(5).trim());
  }

  private parseJson(text: string) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const frame = object(value);
    if (!frame) return;
    const response = object(frame.response);
    const message = object(frame.message);
    const usage =
      object(frame.usage) ?? object(response?.usage) ?? object(message?.usage);
    if (!usage) return;
    const previous = this.current ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const anthropic =
      "cache_read_input_tokens" in usage ||
      "cache_creation_input_tokens" in usage ||
      frame.type === "message_start" ||
      frame.type === "message_delta" ||
      frame.type === "message";
    const inputDetails =
      object(usage.input_tokens_details) ?? object(usage.prompt_tokens_details);
    const cached = tokens(
      anthropic ? usage.cache_read_input_tokens : inputDetails?.cached_tokens,
    );
    const input = tokens(usage.input_tokens ?? usage.prompt_tokens);
    const output = tokens(usage.output_tokens ?? usage.completion_tokens);
    if (input === undefined && output === undefined && cached === undefined)
      return;
    this.current = {
      inputTokens:
        input === undefined
          ? previous.inputTokens
          : Math.max(0, input - (anthropic ? 0 : (cached ?? 0))),
      outputTokens: output ?? previous.outputTokens,
      cacheReadTokens: cached ?? previous.cacheReadTokens,
      cacheWriteTokens:
        tokens(usage.cache_creation_input_tokens) ?? previous.cacheWriteTokens,
    };
  }
}
