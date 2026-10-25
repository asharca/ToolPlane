// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPromptInvocation } from "@/lib/agents/sandbox-runtime";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  raw: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
const invocation: AgentPromptInvocation = {
  name: "review",
  source: {
    marketInstallId: "install",
    releaseId: "release",
    checksum: "immutable-checksum",
    path: "prompts/review.md",
  },
  version: "release",
  rawArguments: '"src/a b.ts" --strict',
  arguments: ["src/a b.ts", "--strict"],
  finalInput: "Review src/a b.ts using strict policy",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (fn) =>
    fn({ $queryRaw: mocks.raw, message: { update: mocks.update } }),
  );
});
describe("trusted Prompt invocation application ledger", () => {
  it("preserves authored text and records immutable source, raw/parsed args and actual final input", async () => {
    const text = { type: "text", text: '/review "src/a b.ts" --strict' };
    mocks.raw.mockResolvedValue([
      {
        parts: [
          text,
          { type: "data-agent-prompt-invocation", data: { source: "forged" } },
        ],
      },
    ]);
    await persistAgentPromptInvocation({
      conversationId: "conversation",
      messageId: "user-message",
      invocation,
    });
    const [sql, messageId, conversationId] = mocks.raw.mock.calls[0];
    expect([messageId, conversationId]).toEqual([
      "user-message",
      "conversation",
    ]);
    expect(sql.join("?")).toMatch(/"role" = 'user'\s+FOR UPDATE/);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-message" },
      data: {
        parts: [
          text,
          { type: "data-agent-prompt-invocation", data: invocation },
        ],
      },
    });
  });
  it("refuses a foreign, missing or non-user message without appending metadata elsewhere", async () => {
    mocks.raw.mockResolvedValue([]);
    await expect(
      persistAgentPromptInvocation({
        conversationId: "foreign-conversation",
        messageId: "assistant-or-foreign",
        invocation,
      }),
    ).rejects.toThrow("Prompt invocation user message is unavailable.");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
