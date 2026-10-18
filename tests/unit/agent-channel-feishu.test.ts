// @vitest-environment node
import { Readable } from "node:stream";
import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "@/lib/agents/channels/adapters/feishu/FeishuAdapter";

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu", Lark: "lark" },
  LoggerLevel: { info: 3 },
  createLarkChannel: vi.fn(),
}));

async function connectedFeishu() {
  const channel = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn(),
    send: vi.fn(
      async (
        _chatId: string,
        _content: Lark.SendInput,
        _options?: Lark.SendOptions,
      ) => ({ messageId: "sent" }),
    ),
    addReaction: vi.fn(async () => "reaction"),
    removeReaction: vi.fn(async () => undefined),
    rawWsClient: { close: vi.fn() },
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: vi.fn(async () => ({
              getReadableStream: () =>
                Readable.from([Buffer.from("hello world")]),
            })),
          },
        },
      },
    },
    stream: vi.fn(
      async (
        _chat: string,
        content: {
          markdown: (controller: {
            setContent: (text: string) => Promise<void>;
          }) => Promise<void>;
        },
      ) => {
        await content.markdown({ setContent: setContent });
        return { messageId: "stream" };
      },
    ),
  };
  const setContent = vi.fn(async (_text: string) => undefined);
  vi.mocked(Lark.createLarkChannel).mockReturnValue(
    channel as unknown as Lark.LarkChannel,
  );
  const adapter = new FeishuAdapter({
    channelId: "feishu",
    agentId: "a",
    channelType: "feishu",
    channelConfig: {
      app_id: "app",
      app_secret: "secret",
      encrypt_key: "",
      verification_token: "",
      domain: "lark",
      allowed_chat_ids: ["allowed"],
    },
  });
  await adapter.connect();
  return { adapter, channel, setContent };
}
const normalized: Lark.NormalizedMessage = {
  chatId: "allowed",
  senderId: "u",
  senderName: "Alice",
  messageId: "m",
  content: "hello",
  resources: [],
  chatType: "p2p",
  rawContentType: "text",
  mentions: [],
  mentionAll: false,
  mentionedBot: false,
  createTime: 1,
};

describe("Feishu channel outcomes", () => {
  it("connects and disconnects with an observable status and closes the raw websocket", async () => {
    const { adapter, channel } = await connectedFeishu();
    expect(adapter.connected).toBe(true);
    expect(Lark.createLarkChannel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        domain: "lark",
        policy: {
          dmMode: "open",
          requireMention: true,
          respondToMentionAll: false,
        },
      }),
    );
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
    expect(channel.disconnect).toHaveBeenCalledOnce();
    expect(channel.rawWsClient.close).toHaveBeenCalledWith({ force: true });
    await expect(
      adapter.sendMessage("allowed", "after disconnect"),
    ).rejects.toThrow("not connected");
  });

  it("preserves thread identity and command arguments and ignores empty messages", async () => {
    const { adapter } = await connectedFeishu();
    const command = vi.fn();
    const message = vi.fn();
    adapter.on("command", command);
    adapter.on("message", message);
    await adapter["handleMessage"]({
      ...normalized,
      content: " /new  another conversation ",
      threadId: "thread",
    });
    expect(command).toHaveBeenCalledExactlyOnceWith({
      chatId: "allowed",
      conversationId: "thread:thread",
      replyInThread: true,
      userId: "u",
      userName: "Alice",
      messageId: "m",
      command: "new",
      args: "another conversation",
    });
    await adapter["handleMessage"]({
      ...normalized,
      content: "  ",
    });
    expect(message).not.toHaveBeenCalled();
    await adapter["handleMessage"]({
      ...normalized,
      content: " hello ",
      threadId: "thread",
    });
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        conversationId: "thread:thread",
        replyInThread: true,
      }),
    );
    await adapter.disconnect();
  });

  it("rate limits rejection notices without leaking unauthorized messages to the agent", async () => {
    const { adapter, channel } = await connectedFeishu();
    const message = vi.fn();
    adapter.on("message", message);
    await adapter["handleMessage"]({
      ...normalized,
      chatId: "denied",
    });
    await adapter["handleMessage"]({
      ...normalized,
      chatId: "denied",
    });
    expect(message).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledExactlyOnceWith(
      "denied",
      { markdown: "Message could not be processed. Please try again." },
      undefined,
    );
    await adapter.disconnect();
  });

  it("downloads resource bytes, classifies images and files and skips unsupported stickers", async () => {
    const { adapter, channel } = await connectedFeishu();
    const message = vi.fn();
    adapter.on("message", message);
    await adapter["handleMessage"]({
      ...normalized,
      content: "",
      resources: [
        { type: "image", fileKey: "image" },
        { type: "file", fileKey: "file", fileName: "notes.txt" },
        { type: "sticker", fileKey: "sticker" },
      ],
    });
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledTimes(
      2,
    );
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [
          {
            data: Buffer.from("hello world").toString("base64"),
            media_type: "image/png",
          },
        ],
        files: [
          {
            filename: "notes.txt",
            media_type: "text/plain",
            data: Buffer.from("hello world").toString("base64"),
            size: 11,
          },
        ],
      }),
    );
    await adapter.disconnect();
  });

  it("transitions status reactions once and sends threaded replies and binary attachments", async () => {
    const { adapter, channel } = await connectedFeishu();
    const opts = { replyToMessageId: "m", replyInThread: true };
    await adapter.sendTypingIndicator("allowed", opts);
    await adapter.sendTypingIndicator("allowed", opts);
    expect(channel.addReaction).toHaveBeenCalledExactlyOnceWith("m", "Typing");
    await adapter.sendMessage("allowed", "answer", opts);
    expect(channel.removeReaction).toHaveBeenCalledWith("m", "reaction");
    expect(channel.addReaction).toHaveBeenLastCalledWith("m", "OK");
    expect(channel.send).toHaveBeenLastCalledWith(
      "allowed",
      { markdown: "answer" },
      { replyTo: "m", replyInThread: true },
    );
    const data = Buffer.from("binary").toString("base64");
    await adapter.sendFile("allowed", {
      data,
      media_type: "image/png",
      filename: "a.png",
      size: 6,
    });
    expect(channel.send).toHaveBeenLastCalledWith("allowed", {
      image: { source: Buffer.from("binary") },
    });
    await adapter.sendFile("allowed", {
      data,
      media_type: "text/plain",
      filename: "a.txt",
      size: 6,
    });
    expect(channel.send).toHaveBeenLastCalledWith("allowed", {
      file: { source: Buffer.from("binary"), fileName: "a.txt" },
    });
    await adapter.disconnect();
  });

  it("edits a streaming card to completion and reports failures without creating a second stream", async () => {
    const { adapter, channel, setContent } = await connectedFeishu();
    expect(await adapter.onStreamComplete("allowed", "none")).toBe(false);
    await adapter.onTextUpdate("allowed", "partial");
    await adapter.onTextUpdate("allowed", "more");
    expect(await adapter.onStreamComplete("allowed", "finished")).toBe(true);
    expect(setContent.mock.calls.map(([text]) => text)).toEqual([
      "partial",
      "more",
      "finished",
    ]);
    expect(channel.stream).toHaveBeenCalledOnce();
    await adapter.onTextUpdate("allowed", "second");
    await adapter.onStreamError("allowed", "failed");
    expect(setContent).toHaveBeenLastCalledWith(
      "second\n\n---\n**Error**: failed",
    );
    await adapter.onStreamError("allowed", "no stream");
    expect(channel.send).toHaveBeenLastCalledWith(
      "allowed",
      { markdown: "**Error**: no stream" },
      undefined,
    );
    await adapter.disconnect();
  });

  it.each(["\n\n", "\n", " ", ""])(
    "splits threaded replies at %j boundaries without losing content",
    async (separator) => {
      const { adapter, channel } = await connectedFeishu();
      const text = `paragraph${separator}`.repeat(900);
      await adapter.sendMessage("allowed", text, {
        replyToMessageId: "m",
        replyInThread: true,
      });
      const chunks = channel.send.mock.calls.map(([, content]) => {
        if (!("markdown" in content))
          throw new Error("Expected a Markdown reply");
        return content.markdown;
      });
      expect(chunks.join("")).toBe(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(
        chunks.every(
          (chunk) => typeof chunk === "string" && chunk.length <= 4000,
        ),
      ).toBe(true);
      await adapter.disconnect();
    },
  );

  it("balances split code fences and keeps Unicode pairs intact in threaded replies", async () => {
    const { adapter, channel } = await connectedFeishu();
    const text = `\`\`\`typescript\n${"😀".repeat(5000)}\n\`\`\``;
    await adapter.sendMessage("allowed", text, {
      replyToMessageId: "m",
      replyInThread: true,
    });
    const chunks = channel.send.mock.calls.map(([, content]) => {
      if (!("markdown" in content))
        throw new Error("Expected a Markdown reply");
      return content.markdown;
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^```(?:typescript)?\n/);
      expect(chunk).toMatch(/```$/);
      expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("").match(/😀/g)).toHaveLength(5000);
    await adapter.disconnect();
  });

  it("treats reaction errors as best effort and ignores unsupported numeric reply IDs", async () => {
    const { adapter, channel } = await connectedFeishu();
    channel.addReaction.mockRejectedValueOnce("add failed");
    await expect(
      adapter.sendTypingIndicator("allowed", { replyToMessageId: "m" }),
    ).resolves.toBeUndefined();
    await adapter.sendTypingIndicator("allowed", { replyToMessageId: "m" });
    channel.removeReaction.mockRejectedValueOnce("remove failed");
    await adapter.onStreamError("allowed", "failed", { replyToMessageId: "m" });
    expect(channel.addReaction).toHaveBeenLastCalledWith("m", "CRY");
    await adapter.sendTypingIndicator("allowed");
    await adapter.sendTypingIndicator("allowed", { replyToMessageId: 1 });
    await adapter.sendMessage("allowed", "numeric", {
      replyToMessageId: 1,
      replyInThread: true,
    });
    expect(channel.send).toHaveBeenLastCalledWith(
      "allowed",
      { markdown: "numeric" },
      undefined,
    );
    await adapter.disconnect();
  });

  it("falls back when stream finalization fails and preserves the original agent error when card edits fail", async () => {
    const { adapter, channel, setContent } = await connectedFeishu();
    await adapter.onTextUpdate("allowed", "partial", { replyToMessageId: "m" });
    setContent.mockRejectedValueOnce(new Error("edit rejected"));
    expect(
      await adapter.onStreamComplete("allowed", "final", {
        replyToMessageId: "m",
      }),
    ).toBe(false);
    expect(
      await adapter.onStreamComplete("allowed", "final", {
        replyToMessageId: "m",
      }),
    ).toBe(false);
    await adapter.onTextUpdate("allowed", "", { replyToMessageId: "second" });
    setContent.mockRejectedValueOnce(new Error("edit rejected"));
    await expect(
      adapter.onStreamError("allowed", "agent failed", {
        replyToMessageId: "second",
      }),
    ).resolves.toBeUndefined();
    expect(setContent).toHaveBeenLastCalledWith("**Error**: agent failed");
    channel.stream.mockResolvedValueOnce({ messageId: "early" });
    await expect(
      adapter.onTextUpdate("allowed", "late", { replyToMessageId: "early" }),
    ).rejects.toThrow("before its controller became ready");
    await adapter.disconnect();
  });

  it("skips failed resource downloads but keeps valid text and unknown-type files", async () => {
    const { adapter, channel } = await connectedFeishu();
    const message = vi.fn();
    adapter.on("message", message);
    channel.rawClient.im.v1.messageResource.get.mockRejectedValueOnce(
      "download failed",
    );
    await adapter["handleMessage"]({
      ...normalized,
      resources: [
        { type: "image", fileKey: "bad" },
        { type: "audio", fileKey: "audio" },
        { type: "file", fileKey: "unknown", fileName: "unknown" },
      ],
    });
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        files: [
          expect.objectContaining({
            filename: "audio",
            media_type: "application/octet-stream",
          }),
          expect.objectContaining({
            filename: "unknown",
            media_type: "application/octet-stream",
          }),
        ],
      }),
    );
    await adapter.disconnect();
  });
});
