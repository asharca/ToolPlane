import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as AssistantConversationModule from "@/components/dashboard/chat/AssistantConversation";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

describe("WorkspaceAssistantChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops the newly admitted Run rather than the previous completed snapshot and reports a refused stop", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const stream: { controller?: ReadableStreamDefaultController<Uint8Array> } =
      {};
    const stopped: string[] = [];
    let admitted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/turns") && init?.method === "POST") {
          admitted = true;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream.controller = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"start","messageId":"new-answer"}\n\ndata: {"type":"text-start","id":"text"}\n\ndata: {"type":"text-delta","id":"text","delta":"New Run is active"}\n\n',
                  ),
                );
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
                "X-Chat-Run-Id": "new-run",
                "X-Chat-Cursor": "3",
              },
            },
          );
        }
        if (url.endsWith("/turns") && init?.method === "DELETE") {
          stopped.push(JSON.parse(String(init.body)).turnId);
          return Response.json({
            stopRequested: false,
            turnId: stopped.at(-1),
          });
        }
        if (url.includes("state=1"))
          return Response.json({
            runId: admitted ? "new-run" : "old-run",
            cursor: 3,
            status: admitted ? "pending" : "completed",
            phase: admitted ? "generating" : "completed",
            stopRequested: false,
            confirmations: [],
            messages: [
              {
                id: admitted ? "new-answer" : "old-answer",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: admitted
                      ? "New Run is active"
                      : "Previous completed Run",
                  },
                ],
              },
            ],
          });
        return Response.json({ revision: 1, templates: [] });
      }),
    );
    const view = render(
      <AssistantConversation
        threadId="thread-1"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    try {
      await screen.findByText("Previous completed Run");
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "Next intentional turn",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await screen.findByText("New Run is active");
      await userEvent.click(
        screen.getByRole("button", { name: "Request stop" }),
      );
      await waitFor(() => expect(stopped).toEqual(["new-run"]));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "did not accept a stop request",
      );
      expect(
        screen.queryByText("Stop requested · awaiting confirmation"),
      ).not.toBeInTheDocument();
    } finally {
      stream.controller?.close();
      view.unmount();
    }
  });

  it("stops another tab's pending Run restored by polling after this tab completed its own turn", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const intervals = vi.spyOn(globalThis, "setInterval");
    let admitted = false;
    let remotePending = false;
    let stopRequested = false;
    let acknowledged = false;
    const stopped: string[] = [];
    const submissions: string[] = [];
    const requests = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/turns") && init?.method === "POST") {
          admitted = true;
          submissions.push(String(init.body));
          const frames = [
            { type: "start", messageId: "answer-A" },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Local A completed" },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason: "stop" },
          ];
          return new Response(
            `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
            {
              headers: {
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
                "X-Chat-Run-Id": "run-A",
                "X-Chat-Cursor": "5",
              },
            },
          );
        }
        if (url.endsWith("/turns") && init?.method === "DELETE") {
          stopped.push(JSON.parse(String(init.body)).turnId);
          stopRequested = true;
          return Response.json({ stopRequested: true, turnId: stopped.at(-1) });
        }
        if (url.includes("state=1")) {
          if (!admitted) return new Response(null, { status: 204 });
          return Response.json({
            runId: remotePending ? "run-B" : "run-A",
            cursor: remotePending ? 8 : 5,
            status: acknowledged
              ? "cancelled"
              : remotePending
                ? "pending"
                : "completed",
            phase: acknowledged
              ? "cancelled"
              : remotePending
                ? "generating"
                : "completed",
            stopRequested,
            confirmations: [],
            messages: [
              {
                id: remotePending ? "user-B" : "user-A",
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: remotePending
                      ? "Another tab's intentional request"
                      : "This tab's intentional request",
                  },
                ],
              },
              {
                id: remotePending ? "answer-B" : "answer-A",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: remotePending
                      ? "Other tab B is generating"
                      : "Local A completed",
                  },
                ],
              },
            ],
          });
        }
        if (url.endsWith("/templates"))
          return Response.json({ revision: 1, templates: [] });
        throw new Error(`Unexpected cross-tab lifecycle request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", requests);
    const view = render(
      <AssistantConversation
        threadId="thread-1"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    try {
      const send = screen.getByRole("button", { name: "Send message" });
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "Send message" }),
        ).toBeEnabled(),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "This tab's intentional request",
      );
      await userEvent.click(send);
      await screen.findByText("Local A completed");
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Request stop" }),
        ).not.toBeInTheDocument(),
      );
      remotePending = true;
      const poll = intervals.mock.calls.find(
        ([, delay]) => delay === 2000,
      )?.[0];
      if (typeof poll !== "function")
        throw new Error("Assistant snapshot polling was not registered");
      await act(async () => {
        poll();
      });
      await screen.findByText("Other tab B is generating");
      await userEvent.click(
        screen.getByRole("button", { name: "Request stop" }),
      );
      await waitFor(() => expect(stopped).toEqual(["run-B"]));
      expect(
        await screen.findByText(/Stop requested · awaiting confirmation/),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Local A completed")).toHaveLength(1);
      expect(screen.getAllByText("Other tab B is generating")).toHaveLength(1);
      expect(submissions).toHaveLength(1);
      expect(
        requests.mock.calls.some(([url]) =>
          String(url).includes("afterSequence="),
        ),
      ).toBe(false);
      acknowledged = true;
      await act(async () => {
        poll();
      });
      await waitFor(() => {
        expect(
          screen.queryByText(/Stop requested · awaiting confirmation/),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Request stop" }),
        ).not.toBeInTheDocument();
      });
    } finally {
      view.unmount();
      intervals.mockRestore();
    }
  });

  it("reconciles one canonical turn without duplicating optimistic users or streamed assistant IDs", async () => {
    const { reconcileAssistantMessages } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const messages: Parameters<typeof reconcileAssistantMessages>[0] = [
      {
        id: "history",
        role: "user",
        parts: [{ type: "text", text: "Earlier turn" }],
      },
      {
        id: "client-user",
        role: "user",
        parts: [{ type: "text", text: "Raw template args" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before disconnect." }],
      },
    ];
    const saved: Parameters<typeof reconcileAssistantMessages>[1] = [
      {
        id: "server-user",
        role: "user",
        parts: [{ type: "text", text: "Expanded server prompt" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before" }],
      },
    ];
    const visible = reconcileAssistantMessages(
      messages,
      saved,
      "client-user",
      true,
    );
    expect(visible.map((message) => message.id)).toEqual([
      "history",
      "server-user",
      "server-assistant",
    ]);
    expect(visible[1].parts).toEqual([
      { type: "text", text: "Expanded server prompt" },
    ]);
    expect(visible[2].parts).toEqual([
      { type: "text", text: "Before disconnect." },
    ]);
    expect(
      reconcileAssistantMessages(visible, saved, "client-user", true),
    ).toEqual(visible);
    expect(
      reconcileAssistantMessages(visible, saved, "client-user")[2].parts,
    ).toEqual(saved[1].parts);
  });

  it("never presents an empty thread as disconnected while restoring or after a no-run response", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const deferred: { resolve?: (response: Response) => void } = {};
    const stateResponse = new Promise<Response>((resolve) => {
      deferred.resolve = resolve;
    });
    const requests = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("state=1")
        ? stateResponse
        : Response.json({ revision: 1, templates: [] }),
    );
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-empty"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Disconnected/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
    ).not.toBeInTheDocument();
    deferred.resolve?.(new Response(null, { status: 204 }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Send message" }),
      "A new intentional turn",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(/Disconnected/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
    ).not.toBeInTheDocument();
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it("offers reconnection only after a saved pending run loses its subscription", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const requests = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("state=1"))
        return Response.json({
          runId: "run-pending",
          cursor: 7,
          status: "pending",
          phase: "running",
          stopRequested: false,
          messages: [],
          confirmations: [],
        });
      if (url.includes("/turns/stream?"))
        throw new Error("Subscription disconnected");
      return Response.json({ revision: 1, templates: [] });
    });
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-pending"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Reconnect/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Disconnected/)).toBeInTheDocument();
    expect(requests).toHaveBeenCalledWith(
      "/api/v1/chat/threads/thread-pending/turns/stream?runId=run-pending&afterSequence=7",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it("restores unknown tool outcomes and readable text without submitting execution", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const requests = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("state=1")
        ? Response.json({
            runId: "run-1",
            cursor: 9,
            status: "failed",
            phase: "execution_unknown",
            stopRequested: false,
            messages: [
              {
                id: "answer",
                role: "assistant",
                parts: [
                  {
                    type: "data-prompt-template",
                    data: { unrecognized: true },
                  },
                  { type: "text", text: "Saved readable answer" },
                ],
              },
            ],
            confirmations: [
              {
                id: "confirm-1",
                toolName: "remote_write",
                input: { value: 1 },
                status: "execution_unknown",
              },
              {
                id: "confirmed-success",
                toolName: "remote_lookup",
                input: { query: "saved" },
                status: "succeeded",
                result: {
                  content: [
                    {
                      type: "text",
                      text: "Durably committed result before output publication",
                    },
                  ],
                },
              },
            ],
          })
        : Response.json({ revision: 1, templates: [] }),
    );
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-1"
        revision={2}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Saved readable answer"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Outcome unknown");
    expect(
      screen.getByText(/Durably committed result before output publication/),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved tool result")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve this tool call" }),
    ).not.toBeInTheDocument();
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it.each(["ambiguous transport failure", "runtime_not_ready"])(
    "reuses the exact admitted request and key after %s",
    async (failure) => {
      const { AssistantConversation } = await vi.importActual<
        typeof AssistantConversationModule
      >("@/components/dashboard/chat/AssistantConversation");
      const bodies: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/turns") && init?.method === "POST") {
            bodies.push(String(init.body));
            return failure === "runtime_not_ready"
              ? Response.json(
                  { error: "runtime_not_ready" },
                  { status: 503, headers: { "Retry-After": "5" } },
                )
              : new Response("Transport unavailable", { status: 503 });
          }
          if (String(input).includes("state=1"))
            return new Response(null, { status: 204 });
          return Response.json({ revision: 1, templates: [] });
        }),
      );
      render(
        <AssistantConversation
          threadId="thread-1"
          revision={1}
          revisionId="revision-1"
          readOnly={false}
          initialMessages={[]}
          onConversationChanged={vi.fn()}
          onBranchChange={vi.fn()}
          onStartBranch={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled(),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "Only one intentional turn",
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      const retryButton = await screen.findByRole("button", {
        name: "Retry the same submission",
      });
      if (failure === "runtime_not_ready") {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "platform runtime owner",
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
          "No new turn was started",
        );
        expect(
          screen.queryByRole("button", { name: /Reconnect/ }),
        ).not.toBeInTheDocument();
      }
      expect(bodies).toHaveLength(1);
      await userEvent.click(retryButton);
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[0]).idempotencyKey).toEqual(expect.any(String));
    },
  );
});
