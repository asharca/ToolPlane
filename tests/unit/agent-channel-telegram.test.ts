// @vitest-environment node
import type { Bot, InputFile } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "@/lib/agents/channels/adapters/telegram/TelegramAdapter";

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; payload: Record<string, unknown> }>,
  rejectMarkdown: false,
  rejectHtml: false,
  missingFile: false,
  fileError: null as unknown,
}));
vi.mock("grammy", async () => {
  const actual = await vi.importActual<{
    Bot: typeof Bot;
    InputFile: typeof InputFile;
  }>("grammy");
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string) {
        super(token);
        this.botInfo = {
          id: 100,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        };
        this.api.config.use(async (_prev, method, payload) => {
          transport.calls.push({
            method,
            payload: payload as Record<string, unknown>,
          });
          if (method === "getFile" && transport.fileError !== null)
            throw transport.fileError;
          const options = payload as { parse_mode?: string };
          if (
            method === "sendMessage" &&
            ((options.parse_mode === "MarkdownV2" &&
              transport.rejectMarkdown) ||
              (options.parse_mode === "HTML" && transport.rejectHtml))
          )
            throw new Error("parse failed");
          const result =
            method === "getFile"
              ? {
                  file_id: "file",
                  file_unique_id: "unique",
                  ...(transport.missingFile ? {} : { file_path: "test/file" }),
                }
              : true;
          return { ok: true, result } as never;
        });
      }
      override start = vi.fn(() => new Promise<void>(() => {}));
      override stop = vi.fn(async () => undefined);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  transport.calls = [];
  transport.rejectMarkdown = false;
  transport.rejectHtml = false;
  transport.missingFile = false;
  transport.fileError = null;
});

async function telegram() {
  const adapter = new TelegramAdapter({
    channelId: "telegram",
    agentId: "a",
    channelType: "telegram",
    channelConfig: { bot_token: "123:token", allowed_chat_ids: ["1"] },
  });
  await adapter.connect();
  return { adapter, bot: adapter["bot"] as Bot };
}
const sender = { id: 2, is_bot: false, first_name: "Alice" };

describe("Telegram real update dispatch", () => {
  it("enforces chat authorization before commands and normalizes all registered commands", async () => {
    const { adapter, bot } = await telegram();
    const message = vi.fn();
    const command = vi.fn();
    adapter.on("message", message);
    adapter.on("command", command);
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 9, type: "private", first_name: "Other" },
        from: sender,
        text: "not allowed",
      },
    });
    expect(message).not.toHaveBeenCalled();
    for (const name of ["new", "compact", "help", "whoami"]) {
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 1, type: "private", first_name: "Alice" },
          from: sender,
          text: `/${name}`,
          entities: [
            { type: "bot_command", offset: 0, length: name.length + 1 },
          ],
        },
      });
    }
    expect(command.mock.calls.map(([event]) => event.command)).toEqual([
      "new",
      "compact",
      "help",
      "whoami",
    ]);
    expect(command).toHaveBeenCalledWith({
      chatId: "1",
      userId: "2",
      userName: "Alice",
      command: "help",
    });
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        date: 1,
        chat: { id: 1, type: "private", first_name: "Alice" },
        from: sender,
        text: "hello",
      },
    });
    expect(message).toHaveBeenCalledExactlyOnceWith({
      chatId: "1",
      userId: "2",
      userName: "Alice",
      text: "hello",
    });
    await adapter.disconnect();
  });

  it("downloads the largest photo and documents with captions and rejects oversized documents", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l9sAAAAASUVORK5CYII=";
    vi.stubGlobal(
      "fetch",
      vi
        .fn(
          async () =>
            new Response("bytes", { headers: { "content-type": "image/png" } }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array(Buffer.from(png, "base64"))),
        ),
    );
    const { adapter, bot } = await telegram();
    const message = vi.fn();
    adapter.on("message", message);
    const base = {
      message_id: 1,
      date: 1,
      chat: { id: 1, type: "private" as const, first_name: "Alice" },
      from: sender,
      caption: " caption ",
    };
    await bot.handleUpdate({
      update_id: 1,
      message: {
        ...base,
        photo: [
          { file_id: "small", file_unique_id: "s", width: 1, height: 1 },
          { file_id: "large", file_unique_id: "l", width: 10, height: 10 },
        ],
      },
    });
    expect(
      transport.calls.find((call) => call.method === "getFile")?.payload,
    ).toEqual({ file_id: "large" });
    expect(message).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "caption",
        images: [{ data: png, media_type: "image/png" }],
      }),
    );
    await bot.handleUpdate({
      update_id: 2,
      message: {
        ...base,
        document: {
          file_id: "doc",
          file_unique_id: "d",
          file_name: "notes.txt",
          mime_type: "text/plain",
          file_size: 5,
        },
      },
    });
    expect(message).toHaveBeenLastCalledWith(
      expect.objectContaining({
        files: [
          {
            filename: "notes.txt",
            media_type: "text/plain",
            data: Buffer.from("bytes").toString("base64"),
            size: 5,
          },
        ],
      }),
    );
    await bot.handleUpdate({
      update_id: 3,
      message: {
        ...base,
        document: {
          file_id: "huge",
          file_unique_id: "h",
          file_size: 200 * 1024 * 1024,
        },
      },
    });
    expect(message).toHaveBeenCalledTimes(2);
    transport.missingFile = true;
    await bot.handleUpdate({
      update_id: 4,
      message: {
        ...base,
        caption: undefined,
        photo: [
          { file_id: "missing", file_unique_id: "m", width: 1, height: 1 },
        ],
      },
    });
    expect(message).toHaveBeenCalledTimes(2);
    await adapter.disconnect();
  });

  it("falls back to the original text and preserves numeric reply targets when Markdown fails", async () => {
    const { adapter } = await telegram();
    transport.rejectMarkdown = true;
    await adapter.sendMessage("1", "a_b!", { replyToMessageId: 42 });
    expect(
      transport.calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => call.payload),
    ).toEqual([
      expect.objectContaining({
        chat_id: "1",
        parse_mode: "MarkdownV2",
        reply_parameters: { message_id: 42 },
      }),
      { chat_id: "1", text: "a_b!", reply_parameters: { message_id: 42 } },
    ]);
    transport.rejectHtml = true;
    await expect(
      adapter.sendMessage("1", "<b>hello</b>", { parseMode: "HTML" }),
    ).rejects.toThrow("parse failed");
    await adapter.disconnect();
  });

  it("sends drafts, binary files and typing and rejects use before connecting", async () => {
    const { adapter } = await telegram();
    await adapter.onTextUpdate("1", "draft");
    await adapter.sendTypingIndicator("1");
    await adapter.sendFile("1", {
      filename: "notes.txt",
      data: Buffer.from("hello").toString("base64"),
      size: 5,
      media_type: "text/plain",
    });
    expect(transport.calls).toContainEqual({
      method: "sendMessageDraft",
      payload: { chat_id: 1, draft_id: 0, text: "draft" },
    });
    expect(transport.calls).toContainEqual({
      method: "sendChatAction",
      payload: { chat_id: "1", action: "typing" },
    });
    expect(
      transport.calls.find((call) => call.method === "sendDocument")?.payload,
    ).toMatchObject({ chat_id: "1", document: { filename: "notes.txt" } });
    await adapter.disconnect();
    await expect(adapter.sendMessage("1", "no connection")).rejects.toThrow(
      "not connected",
    );
    await expect(adapter.sendTypingIndicator("1")).rejects.toThrow(
      "not connected",
    );
    await expect(
      adapter.sendFile("1", {
        filename: "f",
        data: "",
        size: 0,
        media_type: "text/plain",
      }),
    ).rejects.toThrow("not connected");
  });

  it("normalizes anonymous command/text updates without inventing an author", async () => {
    const { adapter, bot } = await telegram();
    const command = vi.fn();
    const message = vi.fn();
    adapter.on("command", command);
    adapter.on("message", message);
    for (const name of ["new", "compact", "help", "whoami"]) {
      // Missing authors intentionally exercise malformed wire input, not a valid SDK fixture.
      const update: Update = JSON.parse(
        JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private", first_name: "Channel" },
            text: `/${name}`,
            entities: [
              { type: "bot_command", offset: 0, length: name.length + 1 },
            ],
          },
        }),
      );
      await bot.handleUpdate(update);
      expect(command).toHaveBeenLastCalledWith({
        chatId: "1",
        userId: "",
        userName: "",
        command: name,
      });
    }
    // Decode deliberately authorless JSON at the same unvalidated update boundary.
    const update: Update = JSON.parse(
      JSON.stringify({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 1, type: "private", first_name: "Channel" },
          text: "announcement",
        },
      }),
    );
    await bot.handleUpdate(update);
    expect(message).toHaveBeenCalledWith({
      chatId: "1",
      userId: "",
      userName: "",
      text: "announcement",
    });
    await adapter.disconnect();
  });

  it.each([new Error("provider rejected"), "untyped provider failure"])(
    "retains captions but drops empty failed media updates: %j",
    async (error) => {
      const { adapter, bot } = await telegram();
      const message = vi.fn();
      adapter.on("message", message);
      transport.fileError = error;
      const base = {
        message_id: 1,
        date: 1,
        from: sender,
        chat: { id: 1, type: "private" as const, first_name: "Channel" },
      };
      for (const caption of [undefined, " keep caption "]) {
        await bot.handleUpdate({
          update_id: 1,
          message: {
            ...base,
            caption,
            photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
          },
        });
        await bot.handleUpdate({
          update_id: 2,
          message: {
            ...base,
            caption,
            document: { file_id: "d", file_unique_id: "d" },
          },
        });
      }
      expect(message).toHaveBeenCalledTimes(2);
      expect(message.mock.calls.map(([event]) => event)).toEqual([
        { chatId: "1", userId: "2", userName: "Alice", text: "keep caption" },
        { chatId: "1", userId: "2", userName: "Alice", text: "keep caption" },
      ]);
      await adapter.disconnect();
    },
  );

  it("drops missing-path documents and empty photos but preserves default document names and inferred MIME", async () => {
    const { adapter, bot } = await telegram();
    const message = vi.fn();
    adapter.on("message", message);
    const base = {
      message_id: 1,
      date: 1,
      from: sender,
      chat: { id: 1, type: "private" as const, first_name: "Channel" },
    };
    await bot.handleUpdate({ update_id: 1, message: { ...base, photo: [] } });
    transport.missingFile = true;
    await bot.handleUpdate({
      update_id: 2,
      message: { ...base, document: { file_id: "d", file_unique_id: "d" } },
    });
    expect(message).not.toHaveBeenCalled();
    transport.missingFile = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("file", { headers: { "content-type": "text/plain" } }),
      ),
    );
    await bot.handleUpdate({
      update_id: 3,
      message: { ...base, document: { file_id: "d", file_unique_id: "d" } },
    });
    expect(message).toHaveBeenCalledWith({
      chatId: "1",
      userId: "2",
      userName: "Alice",
      text: "",
      files: [
        {
          filename: "document",
          media_type: "text/plain",
          data: "ZmlsZQ==",
          size: 4,
        },
      ],
    });
    await adapter.disconnect();
  });
});
