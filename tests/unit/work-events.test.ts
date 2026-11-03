// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), work: vi.fn() }));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/work/sessions", () => ({ getWorkSessionForUser: mocks.work }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/workspace/access-stream", () => ({
  workspaceAccessStream: (stream: ReadableStream<Uint8Array>) => stream,
}));
import { GET } from "@/app/api/v1/work-sessions/[workSessionId]/events/route";
import {
  finishWorkOutput,
  publishWorkOutput,
  publishWorkExecutionStage,
  startWorkOutput,
  subscribeWorkOutput,
} from "@/lib/work/run-control";

function work(status: string, text = "") {
  return {
    workspaceId: "workspace-events",
    status,
    conversation: {
      messages: text
        ? [{ role: "assistant", parts: [{ type: "text", text }] }]
        : [],
    },
  };
}
async function open(id: string) {
  return GET(
    new Request(`http://localhost/api/v1/work-sessions/${id}/events`),
    {
      params: Promise.resolve({ workSessionId: id }),
    },
  );
}
function retained(id: string) {
  startWorkOutput(id, { startedAt: 100 });
  publishWorkOutput(id, "previous-turn");
  finishWorkOutput(id);
}

describe("Work events across consecutive turns", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "user-events" });
  });

  it("keeps a queued follow-up subscribed instead of replaying the previous completion", async () => {
    const id = "events-queued-follow-up";
    retained(id);
    mocks.work.mockResolvedValue(work("queued"));
    const response = await open(id);
    const output = response.text();
    startWorkOutput(id, { startedAt: 200 });
    publishWorkOutput(id, "current-turn");
    finishWorkOutput(id);
    const text = await output;
    expect(text).toContain("event: start");
    expect(text).toContain('"startedAt":200');
    expect(text).toContain("current-turn");
    expect(text).toContain("event: done");
    expect(text).not.toContain("previous-turn");
  });

  it("returns current persisted output when completion races the initial live lookup", async () => {
    const id = "events-terminal-lookup-race";
    retained(id);
    mocks.work
      .mockResolvedValueOnce(work("running"))
      .mockResolvedValueOnce(work("idle", "persisted-current-turn"));
    const response = await open(id);
    const text = await response.text();
    expect(text).toContain("persisted-current-turn");
    expect(text).toContain("event: done");
    expect(text).not.toContain("previous-turn");
  });

  it("does not close a newly started turn when the terminal recheck resolves late", async () => {
    const id = "events-delayed-recheck";
    retained(id);
    const recheck = Promise.withResolvers<ReturnType<typeof work>>();
    mocks.work
      .mockResolvedValueOnce(work("queued"))
      .mockReturnValueOnce(recheck.promise);
    const response = await open(id);
    const output = response.text();
    startWorkOutput(id, { startedAt: 300 });
    recheck.resolve(work("idle", "stale-persisted-turn"));
    await recheck.promise;
    publishWorkOutput(id, "new-live-turn");
    finishWorkOutput(id);
    const text = await output;
    expect(text).toContain("new-live-turn");
    expect(text).toContain('"startedAt":300');
    expect(text).not.toContain("stale-persisted-turn");
  });

  it("replays only the live stage and clears it at completion and on the next turn", () => {
    const id = "events-execution-stage";
    startWorkOutput(id);
    publishWorkExecutionStage(id, "waiting-model");
    const subscription = subscribeWorkOutput(id, () => {});
    expect(subscription.snapshot.executionStage).toBe("waiting-model");
    subscription.unsubscribe();
    finishWorkOutput(id);
    publishWorkExecutionStage(id, "generating");
    const terminal = subscribeWorkOutput(id, () => {});
    expect(terminal.snapshot.executionStage).toBeUndefined();
    terminal.unsubscribe();
    startWorkOutput(id);
    const next = subscribeWorkOutput(id, () => {});
    expect(next.snapshot.executionStage).toBe("queued");
    next.unsubscribe();
    finishWorkOutput(id);
  });

  it("does not replay historical unfinished tools as live execution", async () => {
    mocks.work.mockResolvedValue({
      ...work("idle"),
      conversation: {
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "work-tool",
                toolCallId: "interrupted",
                toolName: "bash",
                status: "running",
              },
            ],
          },
        ],
      },
    });
    const response = await open("events-historical-interruption");
    const text = await response.text();
    expect(text).toContain('"status":"cancelled"');
    expect(text).not.toContain('"status":"running"');
    expect(text).not.toContain("executionStage");
  });
});
