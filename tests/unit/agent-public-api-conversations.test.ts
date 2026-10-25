// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  wrapper: vi.fn(),
  cursor: vi.fn(),
  messages: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agentPublicConversation: { findFirst: m.wrapper },
    message: {
      findFirst: m.cursor,
      findMany: m.messages,
    },
  },
}));
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import { AGENT_API_MAX_TRANSCRIPT_CHARACTERS as max } from "@/lib/agents/public-api/body";
import { getAgentConversationForPrincipal as read } from "@/lib/agents/public-api/conversations";
const principal: AgentApiPrincipal = {
  credentialType: "client_token",
  endpointId: "endpoint",
  endpointPublicId: "public",
  workspaceId: "workspace",
  sourceAgentId: "source",
  revisionId: "revision",
  clientId: "client",
  keyId: null,
  subjectHash: "subject",
  origin: "https://example.com",
  scopes: ["conversations:read", "conversations:delete"],
  limits: {
    rpm: 60,
    dailyRequests: 1000,
    maxConcurrent: 2,
    timeoutSeconds: 60,
    retentionDays: 30,
  },
  rateBuckets: {
    endpointRpm: 60,
    clientRpm: 60,
    endpointDaily: 1000,
    clientDaily: 1000,
  },
};
const date = new Date("2030-01-01T00:00:00Z");
const wrapper = {
  id: "wrapper",
  publicId: "conversation-public",
  createdAt: date,
  revision: { version: 3 },
  conversationId: "conversation",
  deletingAt: null,
  endpoint: { workspaceId: "workspace" },
  runtimeAllocation: { id: "allocation", runtimeAgentId: "runtime" },
  conversation: {
    id: "conversation",
    runtimeSessionId: "session",
    runtimeSessionKey: "key",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.wrapper.mockResolvedValue(wrapper);
  m.messages.mockResolvedValue([]);
  m.cursor.mockResolvedValue({ id: "previous" });
});
describe("public conversation transcript isolation", () => {
  it("conceals conversations outside the endpoint, client or browser subject", async () => {
    m.wrapper.mockResolvedValue(null);
    expect(await read(principal, "foreign")).toBeNull();
    expect(m.wrapper).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicId: "foreign",
          endpointId: "endpoint",
          clientId: "client",
          subjectHash: "subject",
          deletingAt: null,
        },
      }),
    );
    expect(m.messages).not.toHaveBeenCalled();
    await read({ ...principal, subjectHash: null }, "foreign");
    expect(m.wrapper).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          publicId: "foreign",
          endpointId: "endpoint",
          clientId: "client",
          deletingAt: null,
        },
      }),
    );
  });
  it("returns text-only public messages in stable order and paginates after the last visible row", async () => {
    m.messages
      .mockResolvedValueOnce([
        { id: "user", role: "user", createdAt: date, textCharacters: 5 },
        {
          id: "assistant",
          role: "assistant",
          createdAt: date,
          textCharacters: 5,
        },
        { id: "next", role: "user", createdAt: date, textCharacters: 1 },
      ])
      .mockResolvedValueOnce([
        {
          id: "assistant",
          parts: [
            { type: "text", text: "Hello" },
            { type: "tool-call", text: "hidden" },
            null,
            { type: "text", text: 42 },
          ],
        },
        {
          id: "user",
          parts: [
            { type: "text", text: "Hel" },
            { type: "text", text: "lo" },
          ],
        },
      ]);
    expect(
      await read(principal, "conversation-public", {
        limit: 2,
        after: " previous ",
      }),
    ).toEqual({
      id: "conversation-public",
      object: "agent.conversation",
      endpoint_id: "public",
      endpoint_revision: 3,
      created_at: 1893456000,
      messages: [
        { id: "user", role: "user", content: "Hello", created_at: 1893456000 },
        {
          id: "assistant",
          role: "assistant",
          content: "Hello",
          created_at: 1893456000,
        },
      ],
      has_more: true,
      next_cursor: "assistant",
    });
    expect(m.cursor).toHaveBeenCalledWith({
      where: { id: "previous", conversationId: "conversation" },
      select: { id: true },
    });
    expect(m.messages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 3,
        cursor: { id: "previous" },
        skip: 1,
        where: {
          conversationId: "conversation",
          role: { in: ["user", "assistant"] },
        },
      }),
    );
  });
  it("rejects a cursor from another transcript", async () => {
    m.cursor.mockResolvedValue(null);
    await expect(
      read(principal, "conversation-public", { after: "foreign-message" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "The conversation cursor is invalid.",
    });
    expect(m.messages).not.toHaveBeenCalled();
  });
  it("bounds page sizes and returns an empty transcript without fetching message bodies", async () => {
    for (const [limit, take] of [
      [0, 2],
      [1000, 101],
      [undefined, 21],
    ]) {
      const result = await read(principal, "conversation-public", { limit });
      expect(result).toMatchObject({
        messages: [],
        has_more: false,
        next_cursor: null,
      });
      expect(m.messages).toHaveBeenLastCalledWith(
        expect.objectContaining({ take }),
      );
    }
    expect(m.messages).toHaveBeenCalledTimes(3);
  });
  it("bounds transcript characters and truncates a single oversized message", async () => {
    m.messages
      .mockResolvedValueOnce([
        {
          id: "first",
          role: "assistant",
          createdAt: date,
          textCharacters: max + 5,
        },
        { id: "second", role: "user", createdAt: date, textCharacters: 1 },
      ])
      .mockResolvedValueOnce([
        { id: "first", parts: [{ type: "text", text: "x".repeat(max + 5) }] },
      ]);
    const result = await read(principal, "conversation-public");
    expect(result?.messages).toEqual([
      {
        id: "first",
        role: "assistant",
        content: "x".repeat(max),
        created_at: 1893456000,
      },
    ]);
    expect(result).toMatchObject({ has_more: true, next_cursor: "first" });
  });
  it("omits non-text messages and retains the supplied cursor if no visible content remains", async () => {
    m.messages
      .mockResolvedValueOnce([
        { id: "empty", role: "assistant", createdAt: date, textCharacters: 0 },
        { id: "next", role: "user", createdAt: date, textCharacters: 1 },
      ])
      .mockResolvedValueOnce([{ id: "empty", parts: {} }]);
    expect(
      await read(principal, "conversation-public", {
        limit: 1,
        after: "previous",
      }),
    ).toMatchObject({ messages: [], has_more: true, next_cursor: "previous" });
  });
});
