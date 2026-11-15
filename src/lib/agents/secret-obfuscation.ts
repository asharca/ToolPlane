import "server-only";
import { createHmac } from "node:crypto";

/** Request-local only: never persist this map or attach it to observability context. */
export class AgentSecretObfuscator {
  private readonly outbound: Array<[string, string]> = [];
  private readonly inbound: Array<[string, string]> = [];

  constructor(credentials: Readonly<Record<string, string>>) {
    const seen = new Set<string>();
    const entries = Object.entries(credentials)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .filter(([, value]) => value.length >= 8);
    if (!entries.length) return;
    const key =
      process.env.AUTH_SECRET ||
      (process.env.NODE_ENV === "test" ? "test-secret" : "");
    if (!key) throw new Error("Secret placeholder signing key is unavailable.");
    const values = entries.map(([, value]) => value);
    for (const [name, value] of entries) {
      if (seen.has(value)) continue;
      seen.add(value);
      const label =
        name
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_")
          .slice(0, 32) || "VALUE";
      let placeholder: string;
      let nonce = 0;
      do {
        const digest = createHmac("sha256", key)
          .update("toolplane.agent-secret-placeholder.v1\0")
          .update(name)
          .update("\0")
          .update(value)
          .update(`\0${nonce}`)
          .digest("hex")
          .slice(0, 16)
          .toUpperCase();
        // A credential can itself contain the prefix or its environment name.
        // Fall back to an opaque identifier rather than exposing that value.
        placeholder =
          nonce === 0 ? `TP_SECRET_${label}_${digest}` : `TP_${digest}`;
        nonce++;
      } while (values.some((secret) => placeholder.includes(secret)));
      this.outbound.push([value, placeholder]);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) this.outbound.push([escaped, placeholder]);
      this.inbound.push([placeholder, value]);
    }
    this.outbound.sort(([left], [right]) => right.length - left.length);
  }

  get active() {
    return this.inbound.length > 0;
  }

  redact(text: string): string {
    return replaceLiterals(text, this.outbound);
  }

  redactBody(value: unknown): unknown {
    return this.active
      ? walkStrings(value, (text) => this.redact(text))
      : value;
  }

  redactRequest(
    value: unknown,
    api: "anthropic" | "openai" | "openai-responses",
  ): unknown {
    const redacted = this.redactBody(value);
    const body = record(redacted);
    if (!body || !this.active) return redacted;
    const guidance = this.redact(
      `ToolPlane credential placeholders: ${this.inbound.map(([placeholder]) => placeholder).join(", ")}. These are opaque literal identifiers, not environment variable names. When a tool needs a credential, copy its complete identifier EXACTLY into the tool arguments. Do not rewrite, abbreviate, remove any characters, or add a dollar sign. ToolPlane restores the real credential before tool execution. Never guess or disclose the real values.`,
    );
    if (api === "anthropic") {
      if (Array.isArray(body.system))
        return {
          ...body,
          system: [...body.system, { type: "text", text: guidance }],
        };
      if (typeof body.system === "string" || body.system === undefined)
        return {
          ...body,
          system: body.system ? `${body.system}\n\n${guidance}` : guidance,
        };
    } else if (api === "openai-responses") {
      if (
        typeof body.instructions === "string" ||
        body.instructions === undefined
      )
        return {
          ...body,
          instructions: body.instructions
            ? `${body.instructions}\n\n${guidance}`
            : guidance,
        };
    } else if (Array.isArray(body.messages)) {
      return {
        ...body,
        messages: [{ role: "system", content: guidance }, ...body.messages],
      };
    }
    return redacted;
  }

  restore(value: unknown): unknown {
    return this.active
      ? walkStrings(value, (text) => replaceLiterals(text, this.inbound))
      : value;
  }

  restoreArguments(text: string): string {
    // Arguments are JSON *source*, not a decoded string: quotes, backslashes and
    // line breaks in credentials must remain escaped until Pi parses the call.
    return this.argumentStream().push(text, true);
  }

  argumentStream() {
    return new ArgumentRestorer(this.inbound);
  }
}

function replaceLiterals(
  text: string,
  entries: readonly (readonly [string, string])[],
) {
  if (!entries.length) return text;
  let output = "";
  let offset = 0;
  while (offset < text.length) {
    let position = -1;
    let match: readonly [string, string] | undefined;
    for (const entry of entries) {
      const found = text.indexOf(entry[0], offset);
      if (found >= 0 && (position < 0 || found < position)) {
        position = found;
        match = entry;
      }
    }
    if (!match) return output + text.slice(offset);
    output += text.slice(offset, position) + match[1];
    offset = position + match[0].length;
  }
  return output;
}

function walkStrings(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value))
    return value.map((item) => walkStrings(item, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        transform(key),
        walkStrings(item, transform),
      ]),
    );
  }
  return value;
}

/** Incrementally decode JSON string tokens; retain only an escape and a possible
 * placeholder suffix. This also handles providers emitting Unicode escapes. */
class ArgumentRestorer {
  private pending = "";
  private inString = false;
  private escape = "";

  constructor(
    private readonly entries: readonly (readonly [string, string])[],
  ) {}

  push(source: string, final = false): string {
    let output = "";
    let decoded = "";
    const emit = (complete: boolean) => {
      const input = this.pending + decoded;
      let held = 0;
      if (!complete) {
        for (const [placeholder] of this.entries) {
          for (let length = 1; length < placeholder.length; length++) {
            if (length > held && input.endsWith(placeholder.slice(0, length)))
              held = length;
          }
        }
      }
      this.pending = held ? input.slice(-held) : "";
      const text = replaceLiterals(
        held ? input.slice(0, -held) : input,
        this.entries,
      );
      if (text) output += JSON.stringify(text).slice(1, -1);
      decoded = "";
    };
    for (const char of source) {
      if (!this.inString) {
        output += char;
        if (char === '"') this.inString = true;
      } else if (this.escape) {
        this.escape += char;
        if (
          (this.escape.length === 2 && char !== "u") ||
          this.escape.length === 6
        ) {
          try {
            decoded += JSON.parse(`"${this.escape}"`);
          } catch {
            throw new Error("Invalid model tool arguments.");
          }
          this.escape = "";
        }
      } else if (char === "\\") {
        this.escape = char;
      } else if (char === '"') {
        emit(true);
        output += char;
        this.inString = false;
      } else {
        if (char.charCodeAt(0) < 32)
          throw new Error("Invalid model tool arguments.");
        decoded += char;
      }
    }
    if (this.inString) emit(final);
    if (final && this.escape) {
      output += this.escape;
      this.escape = "";
    }
    return output;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Restore only protocol-defined executable arguments, never assistant prose. */
export function restoreModelToolArguments(
  value: unknown,
  secrets: AgentSecretObfuscator,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => restoreModelToolArguments(item, secrets));
  const source = record(value);
  if (!source) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "input" && source.type === "tool_use") {
      output[key] = secrets.restore(item);
    } else if (key === "arguments" && source.type === "function_call") {
      output[key] =
        typeof item === "string"
          ? secrets.restoreArguments(item)
          : secrets.restore(item);
    } else if (key === "function" || key === "function_call") {
      const call = record(item);
      output[key] =
        call && typeof call.arguments === "string"
          ? { ...call, arguments: secrets.restoreArguments(call.arguments) }
          : item;
    } else {
      output[key] = restoreModelToolArguments(item, secrets);
    }
  }
  return output;
}

/** Decode SSE frames before touching JSON, including split UTF-8 and CRLF bytes. */
export function restoreModelResponse(
  response: Response,
  secrets: AgentSecretObfuscator,
): Response {
  if (
    !secrets.active ||
    !response.body ||
    [204, 205, 304].includes(response.status)
  )
    return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  const type = headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    return new Response(restoreSse(response.body, secrets), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (type.includes("json")) {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const value: unknown = await response.json();
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify(restoreModelToolArguments(value, secrets)),
            ),
          );
          controller.close();
        } catch {
          controller.error(new Error("Model response transformation failed."));
        }
      },
      cancel(reason) {
        return response.body?.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}

function restoreSse(
  body: ReadableStream<Uint8Array>,
  secrets: AgentSecretObfuscator,
) {
  const calls = new Map<
    string,
    { restorer: ArgumentRestorer; delta: (text: string) => unknown }
  >();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const encodeEvent = (data: unknown, event?: string) =>
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  const flush = (key: string, event?: string) => {
    const call = calls.get(key);
    if (!call) return "";
    calls.delete(key);
    const text = call.restorer.push("", true);
    return text ? encodeEvent(call.delta(text), event) : "";
  };
  const delta = (
    key: string,
    text: string,
    make: (text: string) => unknown,
  ) => {
    let call = calls.get(key);
    if (!call) {
      call = { restorer: secrets.argumentStream(), delta: make };
      calls.set(key, call);
    }
    return call.restorer.push(text);
  };
  const frame = (input: string) => {
    const lines = input.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return `${input}\n\n`;
    if (data === "[DONE]") {
      let prefix = "";
      for (const key of calls.keys()) prefix += flush(key);
      return `${prefix}${input}\n\n`;
    }
    let value: Record<string, unknown>;
    try {
      const parsed = record(JSON.parse(data));
      if (!parsed) return `${input}\n\n`;
      value = parsed;
    } catch {
      // Do not attach the invalid frame (or a parser error including it) to logs.
      throw new Error("Invalid model event stream.");
    }
    let prefix = "";
    const part = record(value.delta);
    if (
      value.type === "content_block_delta" &&
      part?.type === "input_json_delta" &&
      typeof part.partial_json === "string"
    ) {
      const index = value.index;
      part.partial_json = delta(
        `anthropic:${index}`,
        part.partial_json,
        (text) => ({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: text },
        }),
      );
    }
    if (value.type === "content_block_stop")
      prefix += flush(`anthropic:${value.index}`, "content_block_delta");
    if (Array.isArray(value.choices)) {
      for (const item of value.choices) {
        const choice = record(item);
        const change = record(choice?.delta);
        if (!choice) continue;
        const choiceIndex = choice.index ?? 0;
        if (Array.isArray(change?.tool_calls)) {
          for (const item of change.tool_calls) {
            const tool = record(item);
            const fn = record(tool?.function);
            if (!tool || typeof fn?.arguments !== "string") continue;
            const toolIndex = tool.index ?? 0;
            fn.arguments = delta(
              `openai:${choiceIndex}:${toolIndex}`,
              fn.arguments,
              (text) => ({
                ...value,
                choices: [
                  {
                    index: choiceIndex,
                    delta: {
                      tool_calls: [
                        { index: toolIndex, function: { arguments: text } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }),
            );
          }
        }
        const legacy = record(change?.function_call);
        if (typeof legacy?.arguments === "string") {
          legacy.arguments = delta(
            `openai:${choiceIndex}:legacy`,
            legacy.arguments,
            (text) => ({
              ...value,
              choices: [
                {
                  index: choiceIndex,
                  delta: { function_call: { arguments: text } },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
        if (choice.finish_reason) {
          for (const key of calls.keys())
            if (key.startsWith(`openai:${choiceIndex}:`)) prefix += flush(key);
        }
      }
    }
    if (
      value.type === "response.function_call_arguments.delta" &&
      typeof value.delta === "string"
    ) {
      const key = `responses:${value.item_id ?? value.output_index}`;
      value.delta = delta(key, value.delta, (text) => ({
        ...value,
        delta: text,
      }));
    }
    if (value.type === "response.function_call_arguments.done") {
      prefix += flush(
        `responses:${value.item_id ?? value.output_index}`,
        String(value.type).replace(".done", ".delta"),
      );
      if (typeof value.arguments === "string")
        value.arguments = secrets.restoreArguments(value.arguments);
    }
    // Delta strings above are already restored; don't recursively restore them a
    // second time (a credential may itself contain placeholder-shaped text).
    const transformed =
      value.type === "content_block_delta" ||
      value.type === "response.function_call_arguments.delta" ||
      Array.isArray(value.choices)
        ? value
        : restoreModelToolArguments(value, secrets);
    return (
      prefix +
      lines
        .filter((line) => !line.startsWith("data:"))
        .concat(`data: ${JSON.stringify(transformed)}`)
        .join("\n") +
      "\n\n"
    );
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(pending);
        while (boundary) {
          const input = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          controller.enqueue(encoder.encode(frame(input)));
          boundary = /\r?\n\r?\n/.exec(pending);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(frame(pending)));
        for (const key of calls.keys()) {
          const event = key.startsWith("anthropic:")
            ? "content_block_delta"
            : undefined;
          const output = flush(key, event);
          if (output) controller.enqueue(encoder.encode(output));
        }
      },
    }),
  );
}
