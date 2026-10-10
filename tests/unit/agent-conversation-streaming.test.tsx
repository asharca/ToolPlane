import { assertDefined } from "../assert-defined";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConversation } from "@/components/dashboard/agents/AgentConversation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders successive assistant text deltas before the response finishes", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const fetch = vi.fn().mockResolvedValue(
    new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  const emit = (value: object) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  render(
    <AgentConversation
      activeConversationId="stream-test"
      agentId="agent-test"
      agentName="Streaming test"
      creatingConversation={false}
      ensureConversation={async () => "stream-test"}
      initialMessages={[]}
      ready
      runtimeKind={null}
      onStartBranch={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled(),
  );
  const viewport = screen.getByRole("region", { name: "Streaming test" });
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1600 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  vi.spyOn(viewport, "scrollTo").mockImplementation(
    (options: ScrollToOptions | number) => {
      if (typeof options === "object")
        viewport.scrollTop = Math.min(options.top ?? 0, 1200);
    },
  );
  fireEvent.wheel(viewport, { deltaY: -300 });
  fireEvent.scroll(viewport);
  fireEvent.change(screen.getByPlaceholderText("Message this agent"), {
    target: { value: "Reply incrementally" },
  });
  fireEvent.keyDown(screen.getByPlaceholderText("Message this agent"), {
    key: "Enter",
    code: "Enter",
  });
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(viewport.scrollTop).toBe(1200));
  expect(
    document.querySelectorAll('[data-slot="message-typing"]'),
  ).toHaveLength(1);
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  await act(async () => {
    emit({ type: "start", messageId: "reply" });
    emit({ type: "reasoning-start", id: "thinking" });
    emit({
      type: "reasoning-delta",
      id: "thinking",
      delta: "Read the request.\nCompare the options.",
    });
  });
  await waitFor(() =>
    expect(
      document.querySelector('#chat-message-reply [data-content="text"]'),
    ).toHaveAttribute("data-state", "working"),
  );
  const activity = assertDefined(
    document.querySelector('#chat-message-reply [data-content="text"]'),
  );
  expect(activity).toHaveTextContent("Read the request.");
  expect(activity).toHaveTextContent("Compare the options.");
  expect(
    document.querySelectorAll('[data-slot="message-typing"]'),
  ).toHaveLength(0);
  clock.mockReturnValue(3400);
  await act(async () => {
    emit({ type: "reasoning-end", id: "thinking" });
    emit({ type: "text-start", id: "part" });
    emit({ type: "text-delta", id: "part", delta: "First chunk" });
  });
  await waitFor(() =>
    expect(document.querySelector("#chat-message-reply")).toHaveTextContent(
      "First chunk",
    ),
  );
  expect(document.querySelector("#chat-message-reply")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await waitFor(() => expect(activity).toHaveAttribute("data-state", "closed"));
  const disclosure = assertDefined(activity.querySelector("button"));
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(disclosure).toHaveTextContent("Thought for 2s"));
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(activity).toHaveTextContent("Read the request.");
  expect(activity).toHaveTextContent("Compare the options.");
  await act(async () => {
    emit({ type: "text-delta", id: "part", delta: " then second chunk" });
  });
  await waitFor(() =>
    expect(document.querySelector("#chat-message-reply")).toHaveTextContent(
      "First chunk then second chunk",
    ),
  );
  expect(document.querySelector("#chat-message-reply")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(
    screen.queryByRole("button", { name: "Helpful" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Start a new branch" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    emit({ type: "text-end", id: "part" });
    emit({ type: "finish", finishReason: "stop" });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  });
  await waitFor(() =>
    expect(document.querySelector("#chat-message-reply")).not.toHaveAttribute(
      "aria-busy",
      "true",
    ),
  );
  expect(document.querySelector("#chat-message-reply")).toHaveTextContent(
    "First chunk then second chunk",
  );
  const helpful = await screen.findByRole("button", { name: "Helpful" });
  const branch = screen.getByRole("button", { name: "Start a new branch" });
  expect(helpful.parentElement).toBe(branch.parentElement);
  fireEvent.click(helpful);
  expect(helpful).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Not helpful" }));
  expect(helpful).toHaveAttribute("aria-pressed", "false");
});

it("does not invent a duration for restored reasoning without timing data", async () => {
  render(
    <AgentConversation
      activeConversationId="restored"
      agentId="agent-test"
      agentName="Restored chat"
      creatingConversation={false}
      ensureConversation={async () => "restored"}
      initialMessages={[
        {
          id: "old-reply",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "Earlier reasoning.", state: "done" },
            { type: "text", text: "Earlier answer.", state: "done" },
          ],
        },
      ]}
      ready
      runtimeKind={null}
    />,
  );
  const activity = assertDefined(
    document.querySelector('#chat-message-old-reply [data-content="text"]'),
  );
  expect(activity).toHaveAttribute("data-state", "closed");
  expect(activity).not.toHaveTextContent("0s");
  fireEvent.click(assertDefined(activity.querySelector("button")));
  expect(activity).toHaveTextContent("Earlier reasoning.");
});
