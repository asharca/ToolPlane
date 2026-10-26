import { describe, expect, it } from "vitest";
import {
  assistantSegments,
  expandAssistantMessages,
  type AgentUIMessage,
} from "@/lib/agents/message-segments";

describe("assistant message segments", () => {
  it("normalizes segment ids and ignores malformed or empty segments", () => {
    expect(
      assistantSegments([
        {
          type: "data-assistant-messages",
          data: {
            segments: [
              { id: 7, text: "First" },
              { id: "second", text: "Second" },
              null,
              { id: "empty", text: "  " },
              { id: {}, text: "Invalid" },
              { id: "bad", text: 4 },
            ],
          },
        },
      ]),
    ).toEqual([
      { id: "7", text: "First" },
      { id: "second", text: "Second" },
    ]);
    expect(
      assistantSegments([
        { type: "data-assistant-messages", data: { segments: null } },
      ]),
    ).toEqual([]);
    expect(assistantSegments([{ type: "text" }])).toEqual([]);
  });

  it("expands assistant transcripts in order without changing ordinary messages", () => {
    const user: AgentUIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    };
    const plain: AgentUIMessage = {
      id: "plain",
      role: "assistant",
      parts: [{ type: "text", text: "Answer" }],
    };
    const transcript: AgentUIMessage = {
      id: "turn",
      role: "assistant",
      parts: [
        {
          type: "data-assistant-messages",
          data: {
            segments: [
              { id: "1", text: "One" },
              { id: "2", text: "Two" },
            ],
          },
        },
      ],
    };
    const messages = expandAssistantMessages([user, transcript, plain]);
    expect(messages).toEqual([
      user,
      {
        id: "turn:segment:1",
        role: "assistant",
        parts: [{ type: "text", text: "One", state: "done" }],
      },
      {
        id: "turn:segment:2",
        role: "assistant",
        parts: [{ type: "text", text: "Two", state: "done" }],
      },
      plain,
    ]);
    expect(messages[0]).toBe(user);
    expect(messages[3]).toBe(plain);
  });
});
