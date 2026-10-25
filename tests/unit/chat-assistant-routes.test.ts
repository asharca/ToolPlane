// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyApiToken: vi.fn(),
  verifyApiTokenContext: vi.fn(),
  getCurrentUser: vi.fn(),
  createChatAssistant: vi.fn(),
  updateChatAssistant: vi.fn(),
}));

vi.mock("@/lib/auth/tokens", () => ({
  verifyApiToken: mocks.verifyApiToken,
  verifyApiTokenContext: mocks.verifyApiTokenContext,
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/chat/service", () => ({
  ChatServiceError: class ChatServiceError extends Error {},
  createChatAssistant: mocks.createChatAssistant,
  deleteChatAssistant: vi.fn(),
  getChatAssistantForUser: vi.fn(),
  listChatAssistantsForUser: vi.fn(),
  updateChatAssistant: mocks.updateChatAssistant,
}));

import { POST } from "@/app/api/v1/chat/assistants/route";
import { PATCH } from "@/app/api/v1/chat/assistants/[assistantId]/route";

describe("chat assistant route authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.createChatAssistant.mockResolvedValue({
      id: "assistant-1",
      currentRevisionVersion: 1,
    });
    mocks.updateChatAssistant.mockResolvedValue({
      id: "assistant-1",
      currentRevisionVersion: 2,
    });
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: "user-1" },
      token: { id: "token-1", toolkitId: "toolkit-1" },
    });
  });

  it("rejects scoped credentials before collection or item mutations run", async () => {
    const create = await POST(
      new Request("http://toolplane.test/api/v1/chat/assistants", {
        method: "POST",
        headers: { authorization: "Bearer toolkit-token" },
      }),
    );
    const update = await PATCH(
      new Request("http://toolplane.test/api/v1/chat/assistants/assistant-1", {
        method: "PATCH",
        headers: { authorization: "Bearer toolkit-token" },
      }),
      { params: Promise.resolve({ assistantId: "assistant-1" }) },
    );

    expect(create.status).toBe(401);
    expect(update.status).toBe(401);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.createChatAssistant).not.toHaveBeenCalled();
    expect(mocks.updateChatAssistant).not.toHaveBeenCalled();
  });

  it("passes explicit bounded tool grants on create and required revision on update", async () => {
    const grants = [
      {
        deploymentId: "mcp-1",
        allowedToolNames: ["search"],
        expectedDefinitionChecksum: "a".repeat(64),
      },
    ];
    const create = await POST(
      new Request("http://toolplane.test/api/v1/chat/assistants", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws",
          name: "Helper",
          mcpGrants: grants,
        }),
      }),
    );
    expect(create.status).toBe(201);
    expect(mocks.createChatAssistant).toHaveBeenCalledWith("user-1", {
      workspaceId: "ws",
      name: "Helper",
      mcpGrants: grants,
    });
    const update = await PATCH(
      new Request("http://toolplane.test/api/v1/chat/assistants/assistant-1", {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: 1, mcpGrants: [] }),
      }),
      { params: Promise.resolve({ assistantId: "assistant-1" }) },
    );
    expect(update.status).toBe(200);
    expect(mocks.updateChatAssistant).toHaveBeenCalledWith(
      "user-1",
      "assistant-1",
      { expectedRevision: 1, mcpGrants: [] },
    );
    const approvedUpdate = await PATCH(
      new Request("http://toolplane.test/api/v1/chat/assistants/assistant-1", {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: 2, mcpGrants: grants }),
      }),
      { params: Promise.resolve({ assistantId: "assistant-1" }) },
    );
    expect(approvedUpdate.status).toBe(200);
    expect(mocks.updateChatAssistant).toHaveBeenLastCalledWith(
      "user-1",
      "assistant-1",
      { expectedRevision: 2, mcpGrants: grants },
    );
  });

  it.each([
    { name: "No CAS" },
    { expectedRevision: 1 },
    { expectedRevision: 1, deploymentIds: ["mcp"] },
    { expectedRevision: 1, extensionBindings: [] },
    { expectedRevision: 1, mcpGrants: [{ deploymentId: "mcp" }] },
  ])("rejects invalid update before mutation: %j", async (body) => {
    const response = await PATCH(
      new Request("http://toolplane.test/api/v1/chat/assistants/assistant-1", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ assistantId: "assistant-1" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.updateChatAssistant).not.toHaveBeenCalled();
  });

  it.each([
    { deploymentIds: ["mcp"] },
    { extensionBindings: [] },
    { mcpGrants: [{ deploymentId: "mcp" }] },
  ])(
    "rejects implicit or extension authority on create: %j",
    async (fields) => {
      const response = await POST(
        new Request("http://toolplane.test/api/v1/chat/assistants", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: "ws",
            name: "Helper",
            ...fields,
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mocks.createChatAssistant).not.toHaveBeenCalled();
    },
  );
});
