// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Task, TaskState, SendMessageRequest } from "@a2a-js/sdk";
import {
  toJsonRpcError,
  ExtensionSupportRequiredError,
  ContentTypeNotSupportedError,
} from "@a2a-js/sdk/errors";
import {
  assertTransition,
  historyView,
  taskEvent,
  jsonEvent,
  textArtifact,
} from "@/lib/a2a/model";
import { validateParams, validateSend } from "@/lib/a2a/validation";
import { a2aTransportBodyBytes } from "@/lib/transport-policy";

const message = {
  messageId: "m-1",
  role: "ROLE_USER",
  parts: [{ text: "hello" }],
};
const task = () =>
  Task.fromJSON({
    id: "t-1",
    contextId: "c-1",
    status: { state: "TASK_STATE_WORKING" },
    history: [message, { ...message, messageId: "m-2" }],
    artifacts: [],
  });

describe("native A2A 1.0 protocol contract", () => {
  it("admits configured 512 KiB inline files through wire and SDK validation without widening text or canonical encoding", () => {
    const policy = { allowHttp: false, a2aInlineBytes: 512 * 1024 };
    const request = {
      message: {
        ...message,
        parts: [
          {
            raw: Buffer.alloc(policy.a2aInlineBytes, 97).toString("base64"),
            mediaType: "application/octet-stream",
          },
        ],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
      a2aTransportBodyBytes(policy),
    );
    expect(() =>
      validateParams("SendMessage", request, ["text/plain"], policy),
    ).not.toThrow();
    expect(() =>
      validateSend(
        SendMessageRequest.fromJSON(request),
        ["text/plain"],
        policy,
      ),
    ).not.toThrow();
    expect(() => validateParams("SendMessage", request)).toThrow();
    request.message.parts[0].raw = Buffer.alloc(
      policy.a2aInlineBytes + 1,
    ).toString("base64");
    expect(() =>
      validateParams("SendMessage", request, ["text/plain"], policy),
    ).toThrow();
    request.message.parts[0].raw = "Zh==";
    expect(() =>
      validateParams("SendMessage", request, ["text/plain"], policy),
    ).toThrow();
  });

  it("allows only HTTP scheme relaxation and retains file URL credential and fragment restrictions", () => {
    const policy = { allowHttp: true, a2aInlineBytes: 32 * 1024 };
    const input = (url: string) => ({
      message: {
        ...message,
        parts: [{ url, mediaType: "application/octet-stream" }],
      },
    });
    expect(() =>
      validateParams(
        "SendMessage",
        input("http://files.example/report"),
        ["text/plain"],
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateParams("SendMessage", input("http://files.example/report")),
    ).toThrow();
    for (const url of [
      "ftp://files.example/report",
      "http://user:pass@files.example/report",
      "http://files.example/report#secret",
    ])
      expect(() =>
        validateParams("SendMessage", input(url), ["text/plain"], policy),
      ).toThrow();
  });
  it("uses official oneofs, enums and JSON response shapes without v0.3 fields", () => {
    const value = jsonEvent(taskEvent(task()));
    expect(value).toMatchObject({
      task: {
        id: "t-1",
        status: { state: "TASK_STATE_WORKING" },
        history: [
          { role: "ROLE_USER", parts: [{ text: "hello" }] },
          { messageId: "m-2" },
        ],
      },
    });
    expect(JSON.stringify(value)).not.toContain('"kind"');
    expect(textArtifact("result").parts[0].content).toEqual({
      $case: "text",
      value: "result",
    });
  });
  it("honors historyLength zero without changing the stored task", () => {
    const original = task();
    expect(historyView(original, 0).history).toEqual([]);
    expect(historyView(original, 1).history[0].messageId).toBe("m-2");
    expect(original.history).toHaveLength(2);
    expect(() => historyView(original, -1)).toThrow();
  });
  it.each([3, 4, 5, 7])("never reopens terminal state %s", (state) => {
    expect(() =>
      assertTransition(state, TaskState.TASK_STATE_SUBMITTED),
    ).toThrow();
    expect(() =>
      assertTransition(state, TaskState.TASK_STATE_COMPLETED),
    ).toThrow();
  });
  it("allows input interruption but never turns a queue directly into input-required", () => {
    expect(() => assertTransition(2, 6)).not.toThrow();
    expect(() => assertTransition(6, 1)).not.toThrow();
    expect(() => assertTransition(1, 6)).toThrow();
  });
  it.each([
    { ...message, parts: [{ text: "hello", url: "https://private.test" }] },
    { ...message, role: "user" },
    { ...message, role: "ROLE_AGENT" },
    { ...message, messageId: 17 },
    { ...message, parts: [{ kind: "text", text: "hello" }] },
    { ...message, parts: [{}] },
  ])("rejects lossy coercion and non-standard message shapes", (bad) => {
    expect(() => validateParams("SendMessage", { message: bad })).toThrow();
  });
  it("accepts standard cancel metadata but no caller-controlled system or model", () => {
    expect(() =>
      validateParams("CancelTask", { id: "t-1", metadata: { note: "cancel" } }),
    ).not.toThrow();
    expect(() =>
      validateParams("SendMessage", { message, model: "override" }),
    ).toThrow();
    expect(() =>
      validateParams("SendMessage", {
        message,
        configuration: { returnImmediately: "false" },
      }),
    ).toThrow();
  });
  it.each([
    { url: "http://169.254.169.254" },
    { raw: "YQ==" },
    { data: { a: 1 } },
    { data: null },
    { raw: "YR==", mediaType: "application/octet-stream" },
  ])(
    "rejects malformed or unadvertised input modes without fetching",
    (part) => {
      expect(() =>
        validateParams("SendMessage", {
          message: { ...message, parts: [part] },
        }),
      ).toThrow();
    },
  );
  it.each([
    {
      raw: "YQ==",
      filename: "letter.bin",
      mediaType: "application/octet-stream",
    },
    {
      url: "https://files.example/object?signature=transport-only",
      filename: "report.csv",
      mediaType: "text/csv",
    },
    { data: { toolplaneFileId: "owned-file" }, mediaType: "application/pdf" },
  ])(
    "accepts standard raw/url or owned handle shape, leaving ownership/network checks to intake",
    (part) => {
      expect(() =>
        validateParams("SendMessage", {
          message: { ...message, parts: [part] },
        }),
      ).not.toThrow();
    },
  );
  it.each([
    { raw: "YR==", mediaType: "application/octet-stream" },
    {
      raw: Buffer.alloc(32_769).toString("base64"),
      mediaType: "application/octet-stream",
    },
    {
      raw: "YQ==",
      url: "https://files.example/object",
      mediaType: "application/octet-stream",
    },
    {
      url: "https://user:pass@files.example/object",
      mediaType: "application/octet-stream",
    },
    {
      url: "https://files.example/object#fragment",
      mediaType: "application/octet-stream",
    },
    {
      raw: "YQ==",
      filename: "../secret",
      mediaType: "application/octet-stream",
    },
  ])("rejects noncanonical or unsafe file Parts", (part) => {
    expect(() =>
      validateParams("SendMessage", { message: { ...message, parts: [part] } }),
    ).toThrow();
  });
  it("rejects unknown extensions and published-service image output with standard errors", () => {
    expect(() =>
      validateParams("SendMessage", {
        message: {
          ...message,
          extensions: ["https://unknown.example/extension"],
        },
      }),
    ).toThrow(ExtensionSupportRequiredError);
    const imageOutput = SendMessageRequest.fromJSON({
      message,
      configuration: { acceptedOutputModes: ["image/png"] },
    });
    expect(() => validateSend(imageOutput, ["text/plain"])).toThrow(
      ContentTypeNotSupportedError,
    );
  });
  it("reports standard errors for unsupported push and output modes", () => {
    for (const [configuration, code] of [
      [
        { taskPushNotificationConfig: { url: "https://callback.test" } },
        -32003,
      ],
      [{ acceptedOutputModes: ["invalid-mime"] }, -32005],
    ] as const) {
      try {
        validateSend(SendMessageRequest.fromJSON({ message, configuration }));
        throw new Error("accepted");
      } catch (error) {
        expect(toJsonRpcError(error).code).toBe(code);
      }
    }
  });
});
