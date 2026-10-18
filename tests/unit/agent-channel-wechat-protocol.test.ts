// @vitest-environment node
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeixinBot } from "@/lib/agents/channels/adapters/wechat/WeChatProtocol";
import type { IncomingMessage } from "@/lib/agents/channels/adapters/wechat/WeChatProtocol";

const credentials = {
  token: "token",
  accountId: "account",
  userId: "",
  baseUrl: "https://ilinkai.weixin.qq.com",
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
afterEach(() => vi.unstubAllGlobals());

describe("WeChat iLink message normalization", () => {
  it("preserves media, quoted context and voice formats while ignoring bot messages", async () => {
    const received: IncomingMessage[] = [];
    const media = {
      encrypt_query_param: "encrypted",
      aes_key: Buffer.alloc(16).toString("base64"),
    };
    const items = [
      [
        {
          type: 1,
          text_item: { text: "answer" },
          ref_msg: {
            title: "Alice",
            message_item: { type: 1, text_item: { text: "question" } },
          },
        },
      ],
      [{ type: 2, image_item: { media } }],
      [{ type: 3, voice_item: { media, encode_type: 7, text: "transcript" } }],
      [{ type: 3, voice_item: { media, encode_type: 8 } }],
      [{ type: 3, voice_item: { media } }],
      [{ type: 4, file_item: { media, file_name: "report.pdf" } }],
      [{ type: 5, video_item: { media } }],
      [],
    ];
    const bot = new WeixinBot({ credentials, log });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("getupdates")
            ? {
                get_updates_buf: "cursor",
                msgs: items
                  .map((item_list, index) => ({
                    message_id: String(index),
                    from_user_id: "friend",
                    to_user_id: "account",
                    client_id: "",
                    create_time_ms: 1000,
                    message_type: 1,
                    message_state: 2,
                    context_token: "ctx",
                    item_list,
                  }))
                  .concat([
                    {
                      message_id: "bot",
                      from_user_id: "account",
                      to_user_id: "friend",
                      client_id: "",
                      create_time_ms: 1000,
                      message_type: 2,
                      message_state: 2,
                      context_token: "ctx",
                      item_list: [],
                    },
                  ]),
              }
            : { ret: 0 },
        ),
      ),
    );
    bot.onMessage(async (message) => {
      received.push(message);
      if (message.messageId === "7") await bot.stop();
    });
    await bot.run();
    expect(received).toHaveLength(8);
    expect(received.map((message) => message.type)).toEqual([
      "text",
      "image",
      "voice",
      "voice",
      "voice",
      "file",
      "video",
      "text",
    ]);
    expect(received[0]).toMatchObject({
      text: "[quote: Alice | question]\nanswer",
      timestamp: new Date(1000),
      _contextToken: "ctx",
    });
    expect(received[1]?._imageItems).toEqual([{ media }]);
    expect(received[2]).toMatchObject({
      text: "transcript",
      _fileItems: [{ filename: "voice-2.mp3", mediaType: "audio/mpeg" }],
    });
    expect(received[3]).toMatchObject({
      text: "[voice]",
      _fileItems: [{ filename: "voice-3.ogg", mediaType: "audio/ogg" }],
    });
    expect(received[4]?._fileItems?.[0]).toMatchObject({
      filename: "voice-4.silk",
      mediaType: "audio/silk",
    });
    expect(received[5]?._fileItems?.[0]).toMatchObject({
      filename: "report.pdf",
      mediaType: "application/octet-stream",
    });
    expect(received[6]).toMatchObject({
      text: "[video]",
      _fileItems: [{ filename: "video-6.mp4", mediaType: "video/mp4" }],
    });
  });

  it("uses reply context for subsequent sends and typing, skips typing without context", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json(
          url.endsWith("getconfig") ? { typing_ticket: "ticket" } : { ret: 0 },
        );
      }),
    );
    const bot = new WeixinBot({ credentials, log });
    await bot.sendTyping("unknown");
    await bot.stopTyping("unknown");
    expect(requests).toEqual([]);
    await expect(bot.send("friend", "")).rejects.toThrow("cannot be empty");
    await bot.send("friend", "first");
    expect(requests.at(-1)?.body).toMatchObject({
      msg: { context_token: "", to_user_id: "friend" },
    });
    await bot.reply(
      {
        messageId: "m",
        userId: "friend",
        text: "hi",
        type: "text",
        _contextToken: "ctx",
        timestamp: new Date(),
      },
      "reply",
    );
    await bot.sendTyping("friend");
    await bot.stopTyping("friend");
    await bot.send("friend", "next");
    expect(requests.at(-1)?.body).toMatchObject({
      msg: {
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "next" } }],
      },
    });
    expect(
      requests
        .filter((request) => request.url.endsWith("sendtyping"))
        .map((request) => request.body.status),
    ).toEqual(expect.arrayContaining([1, 2]));
  });

  it.each([
    [new Response("not-json"), "returned non-JSON"],
    [
      Response.json(
        { errmsg: "permission denied", errcode: 403 },
        { status: 403 },
      ),
      "permission denied",
    ],
    [Response.json({ ret: 9, errmsg: "invalid context" }), "invalid context"],
  ])("rejects invalid send responses", async (response, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const bot = new WeixinBot({ credentials, log });
    await expect(bot.send("friend", "hello")).rejects.toThrow(error);
  });
});

describe("WeChat encrypted CDN downloads", () => {
  it.each([
    [[0xff, 0xd8, 1], "image/jpeg"],
    [[0x89, 0x50, 1], "image/png"],
    [[0x47, 0x49, 1], "image/gif"],
    [[0x52, 0x49, 1], "image/webp"],
    [[1, 2, 3], "image/jpeg"],
  ])(
    "decrypts image bytes and detects their MIME type",
    async (bytes, mime) => {
      const data = Buffer.from(bytes);
      const key = Buffer.alloc(16, 7);
      const cipher = createCipheriv("aes-128-ecb", key, null);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new Uint8Array(encrypted))),
      );
      const bot = new WeixinBot({ credentials, log });
      expect(
        await bot.downloadImage({
          media: {
            full_url: "https://novac2c.cdn.weixin.qq.com/file",
            aes_key: key.toString("base64"),
          },
        }),
      ).toBe(`data:${mime};base64,${data.toString("base64")}`);
    },
  );

  it("decodes base64-wrapped hex file keys and keeps original file metadata", async () => {
    const key = Buffer.alloc(16, 3);
    const data = Buffer.from("a real attachment");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const fetch = vi.fn(
      async (_url: string) => new Response(new Uint8Array(encrypted)),
    );
    vi.stubGlobal("fetch", fetch);
    const bot = new WeixinBot({ credentials, log });
    const result = await bot.downloadFile({
      filename: "report.txt",
      mediaType: "text/plain",
      item: {
        media: {
          encrypt_query_param: "a&b",
          aes_key: Buffer.from(key.toString("hex")).toString("base64"),
        },
      },
    });
    expect(result).toEqual({
      filename: "report.txt",
      mediaType: "text/plain",
      data,
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("encrypted_query_param=a%26b");
  });

  it("rejects missing keys, invalid encodings, untrusted URLs and corrupt ciphertext without exposing data", async () => {
    const fetch = vi.fn(async () => new Response("corrupt"));
    vi.stubGlobal("fetch", fetch);
    const bot = new WeixinBot({ credentials, log });
    for (const item of [
      {},
      { media: { full_url: "https://evil.test/file" } },
      { media: { encrypt_query_param: "x" } },
      {
        media: {
          encrypt_query_param: "x",
          aes_key: Buffer.from("bad").toString("base64"),
        },
      },
    ]) {
      expect(await bot.downloadImage(item)).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await bot.downloadImage({
        aeskey: Buffer.alloc(16).toString("hex"),
        media: { encrypt_query_param: "x" },
      }),
    ).toBeNull();
    expect(
      await bot.downloadFile({
        filename: "f",
        mediaType: "text/plain",
        item: {
          aeskey: Buffer.alloc(16).toString("hex"),
          media: { encrypt_query_param: "x" },
        },
      }),
    ).toBeNull();
  });
});

describe("WeChat outbound media protocol", () => {
  it.each(["image/png", "video/mp4", "application/pdf"])(
    "encrypts %s uploads and sends matching metadata",
    async (mediaType) => {
      const source = Buffer.from("private attachment bytes");
      let uploadMetadata: Record<string, unknown> = {};
      let uploaded = Buffer.alloc(0);
      let sent: Record<string, unknown> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith("getuploadurl")) {
            uploadMetadata = JSON.parse(String(init.body));
            return Response.json({
              upload_full_url: "https://novac2c.cdn.weixin.qq.com/upload",
            });
          }
          if (url.includes("cdn.weixin.qq.com")) {
            uploaded = Buffer.from(init.body as Uint8Array);
            return new Response(null, {
              headers: { "x-encrypted-param": "download-token" },
            });
          }
          sent = JSON.parse(String(init.body));
          return Response.json({ ret: 0 });
        }),
      );
      const bot = new WeixinBot({ credentials, log });
      await bot.sendFile("friend", "attachment.pdf", source, mediaType);
      const decipher = createDecipheriv(
        "aes-128-ecb",
        Buffer.from(String(uploadMetadata.aeskey), "hex"),
        null,
      );
      expect(
        Buffer.concat([decipher.update(uploaded), decipher.final()]),
      ).toEqual(source);
      const uploadType = mediaType.startsWith("image")
        ? 1
        : mediaType.startsWith("video")
          ? 2
          : 3;
      expect(uploadMetadata).toMatchObject({
        media_type: uploadType,
        to_user_id: "friend",
        rawsize: source.length,
        filesize: uploaded.length,
        rawfilemd5: createHash("md5").update(source).digest("hex"),
      });
      expect(sent).toMatchObject({
        msg: {
          to_user_id: "friend",
          message_type: 2,
          message_state: 2,
          context_token: "",
          item_list: [
            expect.objectContaining({
              type: uploadType === 1 ? 2 : uploadType === 2 ? 5 : 4,
            }),
          ],
        },
      });
      // The captured outbound message shape is asserted above.
      const message = sent.msg as { item_list: Array<Record<string, unknown>> };
      const item = message.item_list[0];
      const content = item?.[
        uploadType === 1
          ? "image_item"
          : uploadType === 2
            ? "video_item"
            : "file_item"
      ] as Record<string, unknown>;
      expect(content.media).toMatchObject({
        encrypt_query_param: "download-token",
        encrypt_type: 1,
      });
      if (uploadType === 3)
        expect(content).toMatchObject({
          file_name: "attachment.pdf",
          len: String(source.length),
        });
      else
        expect(content[uploadType === 1 ? "mid_size" : "video_size"]).toBe(
          uploaded.length,
        );
    },
  );

  it("uses the legacy upload URL and refuses missing URLs, failed uploads, and absent download tokens", async () => {
    const bot = new WeixinBot({ credentials, log });
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("getuploadurl")
        ? Response.json({ upload_param: "a&b" })
        : new Response(null, { headers: { "x-encrypted-param": "download" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await bot.sendImage("friend", Buffer.from("image"));
    expect(
      fetch.mock.calls.some(([url]) =>
        url.includes("encrypted_query_param=a%26b&filekey="),
      ),
    ).toBe(true);
    fetch.mockImplementation(async () => Response.json({}));
    await expect(bot.sendImage("friend", Buffer.from("image"))).rejects.toThrow(
      "Failed to upload media",
    );
    fetch.mockImplementation(async (url: string) =>
      url.endsWith("getuploadurl")
        ? Response.json({ upload_param: "x" })
        : new Response(null, { status: 503 }),
    );
    await expect(bot.sendImage("friend", Buffer.from("image"))).rejects.toThrow(
      "Failed to upload media",
    );
    fetch.mockImplementation(async (url: string) =>
      url.endsWith("getuploadurl")
        ? Response.json({ upload_param: "x" })
        : new Response(null),
    );
    await expect(bot.sendImage("friend", Buffer.from("image"))).rejects.toThrow(
      "Failed to upload media",
    );
  });

  it("isolates failed message consumers and reports the error while delivering to other consumers", async () => {
    const error = new Error("consumer failed");
    const onError = vi.fn();
    const accepted = vi.fn();
    const bot = new WeixinBot({ credentials, log, onError });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("getupdates")
            ? {
                msgs: [
                  {
                    message_id: "m",
                    from_user_id: "friend",
                    to_user_id: "account",
                    client_id: "",
                    create_time_ms: 0,
                    message_type: 1,
                    message_state: 2,
                    context_token: "ctx",
                    item_list: [{ type: 1, text_item: { text: "hello" } }],
                  },
                ],
              }
            : {},
        ),
      ),
    );
    bot.onMessage(async () => {
      throw error;
    });
    bot.onMessage(async (message) => {
      accepted(message.text);
      await bot.stop();
    });
    await bot.run();
    expect(accepted).toHaveBeenCalledExactlyOnceWith("hello");
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });
});
