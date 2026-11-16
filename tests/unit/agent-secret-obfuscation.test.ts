// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AgentSecretObfuscator,
  restoreModelResponse,
  restoreModelToolArguments,
} from "@/lib/agents/secret-obfuscation";

const secret = 'registered-"token\\with\na-newline';
const secrets = () => new AgentSecretObfuscator({ SERVICE_TOKEN: secret });
const placeholder = secrets().redact(secret);
const event = (value: unknown) =>
  `: 凭据\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

async function streamed(values: unknown[]) {
  const bytes = new TextEncoder().encode(values.map(event).join(""));
  let offset = 0;
  // Split every byte, including multi-byte comment text, frame separators and
  // JSON escapes. Argument fragments also split the ASCII identifier itself.
  const response = restoreModelResponse(
    new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          controller.enqueue(bytes.slice(offset, ++offset));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    secrets(),
  );
  const text = await response.text();
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"));
      if (!data) throw new Error("Missing SSE data frame");
      return JSON.parse(data.slice(5));
    });
}

describe("registered Agent credential obfuscation", () => {
  it("redacts user text, tool results, argument strings, keys and static text without rewriting replacements", () => {
    const scrubber = new AgentSecretObfuscator({
      A: "long-registered-secret",
      B: "registered-secret",
      DUPLICATE: "long-registered-secret",
      SHORT: "tiny",
    });
    const input = {
      system: "long-registered-secret",
      messages: [
        {
          role: "user",
          content: "long-registered-secret / registered-secret / tiny",
        },
        {
          role: "tool",
          content: { "registered-secret": "long-registered-secret" },
        },
        {
          role: "assistant",
          tool_calls: [
            { function: { arguments: '{"key":"registered-secret"}' } },
          ],
        },
      ],
    };
    const output = JSON.stringify(scrubber.redactBody(input));
    expect(output).not.toContain("registered-secret");
    expect(output).toContain(scrubber.redact("long-registered-secret"));
    expect(output).toContain(scrubber.redact("registered-secret"));
    expect(output).toContain("tiny");
    expect(input.system).toBe("long-registered-secret");
    expect(
      new AgentSecretObfuscator({
        B: "registered-secret",
        A: "long-registered-secret",
      }).redact(input.system),
    ).toBe(scrubber.redact(input.system));
  });

  it("uses bare stable ASCII identifiers copied verbatim into executable bash arguments", () => {
    const scrubber = secrets();
    expect(placeholder).toMatch(/^TP_SECRET_SERVICE_TOKEN_[A-F0-9]{16}$/);
    expect(placeholder).toMatch(/^[A-Z0-9_]+$/);
    expect(scrubber.redact(secret)).toBe(placeholder);
    const command = `printf '%s' '${placeholder}' | sha256sum`;
    expect(
      JSON.parse(scrubber.restoreArguments(JSON.stringify({ command }))),
    ).toEqual({
      command: `printf '%s' '${secret}' | sha256sum`,
    });
  });

  it.each(["openai", "anthropic", "openai-responses"] as const)(
    "explains exact literal copying in the %s system instructions without exposing credentials",
    (api) => {
      const body =
        api === "openai-responses"
          ? {
              instructions: "Existing instructions",
              input: [{ role: "user", content: secret }],
            }
          : {
              messages: [{ role: "user", content: secret }],
              ...(api === "anthropic"
                ? { system: [{ type: "text", text: "Existing instructions" }] }
                : {}),
            };
      const output = JSON.stringify(secrets().redactRequest(body, api));
      expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(output).toContain(placeholder);
      expect(output).toContain("copy its complete identifier EXACTLY");
      expect(JSON.stringify(body)).toContain(
        JSON.stringify(secret).slice(1, -1),
      );
    },
  );

  it("never leaks a credential that collides with the marker prefix or its variable name", () => {
    for (const value of ["TP_SECRET", "SERVICE_TOKEN"]) {
      const scrubber = new AgentSecretObfuscator({ SERVICE_TOKEN: value });
      const identifier = scrubber.redact(value);
      expect(identifier).toMatch(/^[A-Z0-9_]+$/);
      expect(identifier).not.toContain(value);
      expect(
        JSON.parse(
          scrubber.restoreArguments(JSON.stringify({ value: identifier })),
        ),
      ).toEqual({ value });
    }
  });

  it("redacts credentials in serialized JSON arguments and restores valid escaped JSON source", () => {
    const scrubber = secrets();
    const input = {
      arguments: JSON.stringify({ token: secret }),
      text: secret,
    };
    expect(scrubber.redactBody(input)).toEqual({
      arguments: `{"token":"${placeholder}"}`,
      text: placeholder,
    });
    expect(
      JSON.parse(scrubber.restoreArguments(`{"token":"${placeholder}"}`)),
    ).toEqual({ token: secret });
    expect(
      JSON.parse(
        scrubber.restoreArguments(`{"token":"\\u0054${placeholder.slice(1)}"}`),
      ),
    ).toEqual({ token: secret });
    expect(new AgentSecretObfuscator({ TOKEN: "1234567" }).active).toBe(false);
    expect(new AgentSecretObfuscator({ TOKEN: "12345678" }).active).toBe(true);
  });

  it("decodes JSON Unicode escapes fragmented across argument deltas", async () => {
    const fragments = [
      '{"token":"\\u0',
      `054${placeholder.slice(1, 8)}`,
      `${placeholder.slice(8)}"}`,
    ];
    const frames = await streamed([
      ...fragments.map((partial_json) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })),
      { type: "content_block_stop", index: 0 },
    ]);
    const json = frames
      .filter((frame) => frame.delta)
      .map((frame) => frame.delta.partial_json)
      .join("");
    expect(JSON.parse(json)).toEqual({ token: secret });
  });

  it("restores only executable arguments in Anthropic, chat completions and Responses JSON", () => {
    const input = {
      content: [
        { type: "text", text: placeholder },
        { type: "tool_use", input: { token: placeholder } },
      ],
      choices: [
        {
          message: {
            content: placeholder,
            tool_calls: [
              { function: { arguments: `{"token":"${placeholder}"}` } },
            ],
          },
        },
      ],
      output: [
        { type: "function_call", arguments: `{"token":"${placeholder}"}` },
      ],
    };
    expect(restoreModelToolArguments(input, secrets())).toEqual({
      content: [
        { type: "text", text: placeholder },
        { type: "tool_use", input: { token: secret } },
      ],
      choices: [
        {
          message: {
            content: placeholder,
            tool_calls: [
              { function: { arguments: JSON.stringify({ token: secret }) } },
            ],
          },
        },
      ],
      output: [
        { type: "function_call", arguments: JSON.stringify({ token: secret }) },
      ],
    });
  });

  it("restores Anthropic argument placeholders split across SSE events and UTF-8 chunks, never prose", async () => {
    const frames = await streamed([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: placeholder },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: `{"token":"${placeholder.slice(0, 8)}`,
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: `${placeholder.slice(8)}"}`,
        },
      },
      { type: "content_block_stop", index: 1 },
    ]);
    expect(frames[0].delta.text).toBe(placeholder);
    const json = frames
      .filter((frame) => frame.delta?.type === "input_json_delta")
      .map((frame) => frame.delta.partial_json)
      .join("");
    expect(JSON.parse(json)).toEqual({ token: secret });
  });

  it("isolates interleaved OpenAI tool calls and choices while restoring fragmented arguments", async () => {
    const chunk = (tool: number, args: string) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: tool, function: { arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    });
    const frames = await streamed([
      chunk(0, `{"token":"${placeholder.slice(0, 8)}`),
      chunk(1, `{"token":"${placeholder.slice(0, 16)}`),
      {
        choices: [
          { index: 1, delta: { content: placeholder }, finish_reason: null },
        ],
      },
      chunk(0, `${placeholder.slice(8)}"}`),
      chunk(1, `${placeholder.slice(16)}"}`),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    for (const index of [0, 1]) {
      const json = frames
        .flatMap((frame) => frame.choices)
        .flatMap((choice) => choice.delta.tool_calls ?? [])
        .filter((tool) => tool.index === index)
        .map((tool) => tool.function.arguments)
        .join("");
      expect(JSON.parse(json)).toEqual({ token: secret });
    }
    expect(frames[2].choices[0].delta.content).toBe(placeholder);
  });

  it("restores Responses delta, done and completed replay arguments without restoring output text", async () => {
    const frames = await streamed([
      {
        type: "response.function_call_arguments.delta",
        item_id: "call",
        delta: `{"token":"${placeholder.slice(0, 8)}`,
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "call",
        delta: `${placeholder.slice(8)}"}`,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "call",
        arguments: `{"token":"${placeholder}"}`,
      },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "function_call", arguments: `{"token":"${placeholder}"}` },
            {
              type: "message",
              content: [{ type: "output_text", text: placeholder }],
            },
          ],
        },
      },
    ]);
    expect(
      JSON.parse(
        frames
          .slice(0, 2)
          .map((frame) => frame.delta)
          .join(""),
      ),
    ).toEqual({ token: secret });
    expect(JSON.parse(frames[2].arguments)).toEqual({ token: secret });
    expect(JSON.parse(frames[3].response.output[0].arguments)).toEqual({
      token: secret,
    });
    expect(frames[3].response.output[1].content[0].text).toBe(placeholder);
  });

  it("preserves unknown and incomplete placeholders, and removes stale response entity headers", async () => {
    const restorer = secrets().argumentStream();
    const prefix = placeholder.slice(0, 8);
    expect(
      restorer.push(`{"token":"TP_SECRET_UNKNOWN_0000000000000000 ${prefix}`),
    ).toBe('{"token":"TP_SECRET_UNKNOWN_0000000000000000 ');
    expect(restorer.push("", true)).toBe(prefix);
    const response = restoreModelResponse(
      Response.json(
        { content: [{ type: "tool_use", input: { token: placeholder } }] },
        {
          headers: { etag: "old-body", "content-length": "1" },
        },
      ),
      secrets(),
    );
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.json()).toMatchObject({
      content: [{ input: { token: secret } }],
    });
  });
});
