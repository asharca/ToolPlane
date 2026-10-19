// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlushController } from "@/lib/agents/channels/FlushController";
import { toSlackMarkdown } from "@/lib/agents/channels/adapters/slack/slackMarkdown";
import { channelFetch } from "@/lib/agents/channels/http";
import {
  downloadFileAsBase64,
  downloadImageAsBase64,
} from "@/lib/agents/channels/media";
import { clampSurrogateBoundary } from "@/lib/agents/channels/text";
import { splitMessage } from "@/lib/agents/channels/utils";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stream flush scheduling", () => {
  it("coalesces updates, batches after idle gaps, and can cancel or reset pending work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const delivered: string[] = [];
    let latest = "a";
    const controller = new FlushController(async () => {
      delivered.push(latest);
    });
    await controller.throttledUpdate();
    latest = "abc";
    await controller.throttledUpdate();
    await vi.advanceTimersByTimeAsync(199);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual(["abc"]);
    latest = "cancelled";
    await controller.throttledUpdate();
    controller.cancelPendingFlush();
    await vi.advanceTimersByTimeAsync(200);
    expect(delivered).toEqual(["abc"]);
    latest = "immediate";
    await controller.throttledUpdate();
    expect(delivered).toEqual(["abc", "immediate"]);
    await vi.advanceTimersByTimeAsync(2100);
    latest = "idle batch";
    await controller.throttledUpdate();
    await vi.advanceTimersByTimeAsync(299);
    expect(delivered).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered.at(-1)).toBe("idle batch");
    controller.complete();
    expect(controller.isCompleted).toBe(true);
    latest = "must not flush";
    await controller.flush();
    expect(delivered).toHaveLength(3);
    controller.reset();
    expect(controller.isCompleted).toBe(false);
    latest = "reset";
    await controller.flush();
    expect(delivered.at(-1)).toBe("reset");
  });

  it("serializes concurrent delivery, reflushes changes received in flight, and resolves completion waiters", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const flush = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const controller = new FlushController(flush);
    const pending = controller.flush();
    const waiter = vi.fn();
    const waited = controller.waitForFlush().then(waiter);
    await controller.flush();
    expect(flush).toHaveBeenCalledOnce();
    expect(waiter).not.toHaveBeenCalled();
    finish?.();
    await pending;
    await waited;
    expect(waiter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(2);
    await controller.waitForFlush();
  });

  it("does not reflush completed streams and releases waiters after failed delivery", async () => {
    vi.useFakeTimers();
    let reject: ((error: Error) => void) | undefined;
    const failure = new Error("delivery failed");
    const flush = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const controller = new FlushController(flush);
    const pending = controller.flush();
    const rejection = expect(pending).rejects.toThrow("delivery failed");
    const waiter = controller.waitForFlush();
    await controller.flush();
    controller.complete();
    await controller.flush();
    reject?.(failure);
    await rejection;
    await waiter;
    await vi.advanceTimersByTimeAsync(1000);
    expect(flush).toHaveBeenCalledOnce();
  });
});

describe("channel text formatting", () => {
  it("converts ordinary markdown without transforming inline or fenced code", () => {
    expect(
      toSlackMarkdown(
        "# Heading\n**bold** *italic* ~~gone~~ [label](https://example.com)\n`**literal**`\n```ts\n**literal**\n``` tail",
      ),
    ).toBe(
      "*Heading*\n*bold* _italic_ ~gone~ <https://example.com|label>\n`**literal**`\n```ts\n**literal**\n``` tail",
    );
    expect(toSlackMarkdown("`code`")).toBe("`code`");
    expect(toSlackMarkdown("")).toBe("");
  });

  it.each([
    ["abcd", 0, 0],
    ["abcd", 4, 4],
    ["abcd", 2, 2],
    ["a😀b", 2, 1],
    ["a😀b", 1, 1],
    ["a😀b", 3, 3],
    ["a\ud800xb", 2, 2],
    ["a\udfff\udfffb", 2, 2],
  ])(
    "keeps UTF-16 split boundaries valid for %j at %i",
    (text, index, expected) => {
      expect(clampSurrogateBoundary(text, index)).toBe(expected);
    },
  );

  it("prefers paragraph, line and word boundaries before falling back to surrogate-safe cuts", () => {
    expect(splitMessage("short", 10)).toEqual(["short"]);
    expect(splitMessage("one\n\ntwo three", 7)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(splitMessage("one\ntwo", 5)).toEqual(["one", "two"]);
    expect(splitMessage("one two", 5)).toEqual(["one", "two"]);
    expect(splitMessage("好😀好😀", 2)).toEqual(["好", "😀", "好", "😀"]);
  });
});

describe("channel downloads and redirects", () => {
  it("removes credentials on trusted cross-origin redirects and preserves same-origin credentials", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/next" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://files.slack.com/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("data"));
    vi.stubGlobal("fetch", fetch);
    expect(
      await (
        await channelFetch("https://slack.com/start", {
          headers: { Authorization: "Bearer secret" },
        })
      ).text(),
    ).toBe("data");
    // Fetch receives the same mutable Headers instance; snapshot at call time instead.
    const snapshots: Array<string | null> = [];
    let count = 0;
    fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      snapshots.push(new Headers(init.headers).get("Authorization"));
      count++;
      if (count === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        });
      if (count === 2)
        return new Response(null, {
          status: 302,
          headers: { location: "https://files.slack.com/final" },
        });
      return new Response(null);
    });
    await channelFetch("https://slack.com/start", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(snapshots).toEqual(["Bearer secret", "Bearer secret", null]);
  });

  it("rejects cross-origin body forwarding and redirect loops", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://files.slack.com/next" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      channelFetch("https://slack.com/start", {
        method: "POST",
        body: "secret body",
      }),
    ).rejects.toThrow("cannot forward request bodies");
    fetch.mockClear();
    await expect(channelFetch("https://slack.com/start")).rejects.toThrow(
      "too many redirects",
    );
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("detects real image bytes instead of trusting Content-Type and preserves file metadata", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l9sAAAAASUVORK5CYII=";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(Buffer.from(png, "base64")), {
          headers: { "content-type": "application/octet-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not an image", {
          headers: { "content-type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response("text", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("raw"))))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await downloadImageAsBase64("https://files.slack.com/image"),
    ).toEqual({ media_type: "image/png", data: png });
    expect(
      await downloadImageAsBase64("https://files.slack.com/fake"),
    ).toBeNull();
    expect(
      await downloadImageAsBase64("https://files.slack.com/missing"),
    ).toBeNull();
    expect(
      await downloadFileAsBase64("https://files.slack.com/text", "notes.txt"),
    ).toEqual({
      filename: "notes.txt",
      size: 4,
      data: Buffer.from("text").toString("base64"),
      media_type: "text/plain",
    });
    expect(
      await downloadFileAsBase64("https://files.slack.com/raw", "raw"),
    ).toMatchObject({ media_type: "application/octet-stream", size: 3 });
    expect(
      await downloadFileAsBase64("https://files.slack.com/missing", "missing"),
    ).toBeNull();
  });
});
