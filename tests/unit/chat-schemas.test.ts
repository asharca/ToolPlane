import { describe, expect, it } from "vitest";
import {
  CreateChatAssistantSchema,
  UpdateChatAssistantSchema,
  UpdateChatThreadSchema,
  parseChatTurn,
} from "@/lib/chat/schemas";

describe("chat bounded-context input", () => {
  it("accepts explicit bounded MCP tool grants", () => {
    const result = CreateChatAssistantSchema.parse({
      workspaceId: "ws-1",
      name: "Helper",
      modelProviderId: "provider-1",
      model: "gpt-5",
      description: "Finds primary sources.",
      modelParameters: {
        temperature: 0.4,
        topP: 0.8,
        maxOutputTokens: 2_000,
        customParameters: [
          { name: "top_k", type: "number", value: 40 },
          {
            name: "response_format",
            type: "json",
            value: '{"type":"json_object"}',
          },
        ],
      },
      mcpGrants: [
        {
          deploymentId: "mcp-1",
        },
      ],
    });

    expect(result.mcpGrants).toEqual([
      {
        deploymentId: "mcp-1",
      },
    ]);
    expect(result.description).toBe("Finds primary sources.");
    expect(result.modelParameters).toEqual({
      temperature: 0.4,
      topP: 0.8,
      maxOutputTokens: 2_000,
      customParameters: [
        { name: "top_k", type: "number", value: 40 },
        {
          name: "response_format",
          type: "json",
          value: '{"type":"json_object"}',
        },
      ],
    });
    expect(result).not.toHaveProperty("skillIds");
    expect(result).not.toHaveProperty("sandboxId");
    expect(result).not.toHaveProperty("runtime");
  });

  it("requires a real patch and a user message as the final turn message", () => {
    expect(UpdateChatAssistantSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelProviderId: "provider-2",
        model: "model-2",
      }).success,
    ).toBe(true);
    expect(
      parseChatTurn({
        messages: [
          {
            id: "a-1",
            role: "assistant",
            parts: [{ type: "text", text: "done" }],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseChatTurn({
        idempotencyKey: "request-1",
        messages: [
          { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        trigger: "regenerate-message",
        messageId: "a-1",
        reasoningEffort: "xhigh",
      }),
    ).toMatchObject({
      trigger: "regenerate-message",
      messageId: "a-1",
      reasoningEffort: "xhigh",
      messages: [expect.objectContaining({ id: "u-1" })],
    });
    expect(
      parseChatTurn({
        messages: [
          { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        reasoningEffort: "extreme",
      }),
    ).toBeNull();
  });

  it("uses the shared assistant tool-call limit", () => {
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        maxSteps: 1000,
      }).success,
    ).toBe(true);
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        maxSteps: 1001,
      }).success,
    ).toBe(false);
  });

  it("bounds optional model parameters and accepts clearing them", () => {
    expect(
      UpdateChatAssistantSchema.parse({
        expectedRevision: 1,
        modelParameters: null,
      }),
    ).toEqual({
      expectedRevision: 1,
      modelParameters: null,
    });
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelParameters: { temperature: 2.1 },
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelParameters: { topP: -0.1 },
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelParameters: { maxOutputTokens: 0 },
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelParameters: {
          customParameters: [
            { name: "response_format", type: "json", value: "{not-json}" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        modelParameters: {
          customParameters: [
            { name: "top_k", type: "number", value: 40 },
            { name: "top_k", type: "number", value: 20 },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires CAS for assistant edits and rejects thread rebinding", () => {
    expect(UpdateChatAssistantSchema.safeParse({ pinned: false }).success).toBe(
      false,
    );
    expect(
      UpdateChatAssistantSchema.safeParse({ expectedRevision: 1 }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.parse({ expectedRevision: 1, pinned: false }),
    ).toEqual({
      expectedRevision: 1,
      pinned: false,
    });
    expect(
      UpdateChatThreadSchema.safeParse({ assistantId: "assistant-2" }).success,
    ).toBe(false);
    expect(UpdateChatThreadSchema.safeParse({ pinned: true }).success).toBe(
      false,
    );
  });

  it.each([
    "deploymentIds",
    "skillIds",
    "sandboxId",
    "runtime",
    "extensionBindings",
  ])("rejects obsolete capability field %s", (field) => {
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        [field]: [],
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        name: "Helper",
        [field]: [],
      }).success,
    ).toBe(false);
  });

  it.each([CreateChatAssistantSchema, UpdateChatAssistantSchema])(
    "accepts deployment grants and rejects client-owned tool lists and pins",
    (schema) => {
      const input =
        schema === CreateChatAssistantSchema
          ? { workspaceId: "ws-1", name: "Helper" }
          : { expectedRevision: 1 };
      expect(
        schema.safeParse({ ...input, mcpGrants: [{ deploymentId: "mcp-1" }] })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({
          ...input,
          mcpGrants: [{ deploymentId: "mcp-1", allowedToolNames: ["search"] }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...input,
          mcpGrants: [
            { deploymentId: "mcp-1", definitionChecksum: "a".repeat(64) },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("accepts deployment-only grants and requires a durable request key", () => {
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        mcpGrants: [{ deploymentId: "mcp-1" }],
      }).success,
    ).toBe(true);
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        mcpGrants: [{ deploymentId: "mcp-1", allowedToolNames: [] }],
      }).success,
    ).toBe(false);
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        mcpGrants: [
          {
            deploymentId: "mcp-1",
            allowedToolNames: ["search"],
            extensionBindings: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateChatAssistantSchema.safeParse({
        workspaceId: "ws-1",
        name: "Helper",
        mcpGrants: [
          {
            deploymentId: "mcp-1",
            allowedToolNames: ["search"],
            definitionChecksum: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      UpdateChatAssistantSchema.safeParse({
        expectedRevision: 1,
        mcpGrants: [
          {
            deploymentId: "mcp-1",
            allowedToolNames: ["search"],
            definitionChecksum: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      parseChatTurn({
        messages: [
          { id: "u", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
      }),
    ).toBeNull();
  });
});
