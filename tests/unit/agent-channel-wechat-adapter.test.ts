// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeChatAdapter } from "@/lib/agents/channels/adapters/wechat/WeChatAdapter";
import { WeixinBot } from "@/lib/agents/channels/adapters/wechat/WeChatProtocol";
import type { IncomingMessage } from "@/lib/agents/channels/adapters/wechat/WeChatProtocol";

afterEach(() => vi.restoreAllMocks());

async function wechat() {
  vi.spyOn(WeixinBot.prototype, "run").mockImplementation(
    () => new Promise<void>(() => {}),
  );
  vi.spyOn(WeixinBot.prototype, "stop").mockResolvedValue();
  const adapter = new WeChatAdapter({
    channelId: "wechat",
    agentId: "a",
    channelType: "wechat",
    channelConfig: {
      token: "token",
      accountId: "account",
      allowed_chat_ids: ["friend"],
    },
  });
  await adapter.connect();
  const bot = adapter["bot"];
  if (!bot) throw new Error("Expected the configured WeChat transport");
  return { adapter, bot };
}
const incoming: IncomingMessage = {
  messageId: "m",
  userId: "friend",
  text: "hello",
  type: "text",
  _contextToken: "ctx",
  timestamp: new Date(0),
};

describe("WeChat agent-facing adapter", () => {
  it("filters unauthorized and empty messages, converts decrypted media, and infers file MIME types", async () => {
    const { adapter, bot } = await wechat();
    const message = vi.fn();
    adapter.on("message", message);
    const downloadImage = vi
      .spyOn(bot, "downloadImage")
      .mockResolvedValueOnce("data:image/png;base64,YQ==")
      .mockResolvedValueOnce(null);
    vi.spyOn(bot, "downloadFile")
      .mockResolvedValueOnce({
        data: Buffer.from("text"),
        filename: "notes.TXT",
        mediaType: "application/octet-stream",
      })
      .mockResolvedValueOnce({
        data: Buffer.from("raw"),
        filename: "unknown",
        mediaType: "application/octet-stream",
      })
      .mockResolvedValueOnce(null);
    await bot["dispatchMessage"]({
      ...incoming,
      userId: "stranger",
      _imageItems: [{}],
    });
    expect(downloadImage).not.toHaveBeenCalled();
    await bot["dispatchMessage"]({ ...incoming, text: " " });
    expect(message).not.toHaveBeenCalled();
    await bot["dispatchMessage"]({
      ...incoming,
      _imageItems: [{}, {}],
      _fileItems: [
        {
          filename: "notes.TXT",
          mediaType: "application/octet-stream",
          item: {},
        },
        {
          filename: "unknown",
          mediaType: "application/octet-stream",
          item: {},
        },
        { filename: "missing", mediaType: "text/plain", item: {} },
      ],
    });
    expect(message).toHaveBeenCalledExactlyOnceWith({
      chatId: "friend",
      userId: "friend",
      userName: "friend",
      messageId: "m",
      text: "hello",
      images: [{ media_type: "image/png", data: "YQ==" }],
      files: [
        {
          filename: "notes.TXT",
          data: Buffer.from("text").toString("base64"),
          size: 4,
          media_type: "text/plain",
        },
        {
          filename: "unknown",
          data: Buffer.from("raw").toString("base64"),
          size: 3,
          media_type: "application/octet-stream",
        },
      ],
    });
    await adapter.disconnect();
    await bot["dispatchMessage"](incoming);
    expect(message).toHaveBeenCalledOnce();
  });

  it("chunks outgoing messages without losing content and stops typing even if delivery fails", async () => {
    const { adapter, bot } = await wechat();
    const send = vi.spyOn(bot, "send").mockResolvedValue();
    const stopTyping = vi.spyOn(bot, "stopTyping").mockResolvedValue();
    const text = "好".repeat(4800);
    await adapter.sendMessage("friend", text);
    expect(send.mock.calls.map(([, chunk]) => chunk).join("")).toBe(text);
    expect(send.mock.calls.every(([, chunk]) => chunk.length <= 2000)).toBe(
      true,
    );
    expect(stopTyping).toHaveBeenCalledExactlyOnceWith("friend");
    send.mockRejectedValueOnce(new Error("delivery failed"));
    stopTyping.mockRejectedValueOnce(new Error("typing failed"));
    await expect(adapter.sendMessage("friend", "fail")).rejects.toThrow(
      "delivery failed",
    );
    expect(stopTyping).toHaveBeenCalledTimes(2);
    const sendFile = vi.spyOn(bot, "sendFile").mockResolvedValue();
    await adapter.sendFile("friend", {
      filename: "notes.txt",
      data: Buffer.from("text").toString("base64"),
      media_type: "text/plain",
      size: 4,
    });
    expect(sendFile).toHaveBeenCalledExactlyOnceWith(
      "friend",
      "notes.txt",
      Buffer.from("text"),
      "text/plain",
    );
    const sendTyping = vi.spyOn(bot, "sendTyping").mockResolvedValue();
    await adapter.sendTypingIndicator("friend");
    expect(sendTyping).toHaveBeenCalledExactlyOnceWith("friend");
    await adapter.disconnect();
    await expect(
      adapter.sendMessage("friend", "after disconnect"),
    ).rejects.toThrow("not connected");
  });
});
