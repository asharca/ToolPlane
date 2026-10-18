// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachmentFindMany: vi.fn(),
  readAttachment: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { workspaceAttachment: { findMany: mocks.attachmentFindMany } },
}));
vi.mock("@/lib/attachments/storage", () => ({
  readWorkspaceAttachment: mocks.readAttachment,
}));

import {
  AttachmentMessageError,
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
  hydrateWorkspaceAttachmentMessages,
} from "@/lib/attachments/messages";

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function stored(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    name: string;
    mimeType: string;
    size: number;
    storagePath: string;
  }> = {},
) {
  return {
    id: "attachment-1",
    workspaceId: "workspace-1",
    name: "file.txt",
    mimeType: "text/plain",
    size: 4,
    storagePath: "objects/file.txt",
    ...overrides,
  };
}

const hydrationInput = {
  workspaceId: "workspace-1",
  scope: { chatThreadId: "thread-1" },
};
const fileMessages = [
  {
    role: "user",
    parts: [{ type: "file", url: "/api/v1/attachments/attachment-1" }],
  },
];

describe("workspace attachment messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores non-files and deduplicates attachment ids while counting duplicate file parts", () => {
    expect(
      attachmentIdsFromParts([
        null,
        undefined,
        1,
        {},
        { type: "text" },
        { type: "file", url: "/api/v1/attachments/a" },
        { type: "file", url: "/api/v1/attachments/a" },
      ]),
    ).toEqual(["a"]);
    expect(() => attachmentIdsFromParts([{ type: "file" }])).toThrow(
      "internal attachment endpoint",
    );
    expect(() =>
      attachmentIdsFromParts(
        Array.from({ length: 6 }, () => ({
          type: "file",
          url: "/api/v1/attachments/a",
        })),
      ),
    ).toThrow("at most 5");
  });

  it.each([null, { workspaceId: "workspace-1", uploadedById: "other" }])(
    "rejects missing attachments or mismatched uploader without revealing ownership",
    async (attachment) => {
      const tx = {
        workspaceAttachment: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue(attachment),
        },
      };
      await expect(
        claimWorkspaceAttachments(tx as never, {
          ids: ["a"],
          workspaceId: "workspace-1",
          uploadedById: "user-1",
          scope: { chatThreadId: "thread-1" },
        }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it("claims fresh attachments without an ownership read and allows same-thread retries", async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1",
          uploadedById: "user-1",
          chatThreadId: "thread-1",
          conversationId: null,
        }),
      },
    };
    const input = {
      ids: ["a"],
      workspaceId: "workspace-1",
      uploadedById: "user-1",
      scope: { chatThreadId: "thread-1" },
    };
    await claimWorkspaceAttachments(tx as never, input);
    expect(tx.workspaceAttachment.findUnique).not.toHaveBeenCalled();
    await claimWorkspaceAttachments(tx as never, input);
    tx.workspaceAttachment.findUnique.mockResolvedValueOnce({
      workspaceId: "workspace-1",
      uploadedById: "user-1",
      chatThreadId: "thread-1",
      conversationId: "other",
    });
    await expect(
      claimWorkspaceAttachments(tx as never, input),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns independent message arrays when no attachments are present", async () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hello" }] },
    ];
    const result = await hydrateWorkspaceAttachmentMessages(
      messages,
      hydrationInput,
    );
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
    expect(result[0].parts).not.toBe(messages[0].parts);
    expect(mocks.attachmentFindMany).not.toHaveBeenCalled();
  });

  it.each<[string, number[]]>([
    ["image/jpeg", [255, 216, 255]],
    ["image/gif", Array.from(Buffer.from("GIF87a"))],
    ["image/gif", Array.from(Buffer.from("GIF89a"))],
    ["image/webp", Array.from(Buffer.from("RIFF0000WEBP"))],
  ])("validates image signatures for %s", async (mimeType, data) => {
    const bytes = Uint8Array.from(data);
    mocks.attachmentFindMany.mockResolvedValue([
      stored({ mimeType, size: bytes.length }),
    ]);
    mocks.readAttachment.mockReturnValue(stream(bytes));
    const result = await hydrateWorkspaceAttachmentMessages(
      fileMessages,
      hydrationInput,
    );
    expect(result[0].parts[1]).toEqual({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
    });
  });

  it.each<[string, number[]]>([
    ["image/jpeg", [255]],
    ["image/jpeg", [0, 216, 255]],
    ["image/jpeg", [255, 0, 255]],
    ["image/jpeg", [255, 216, 0]],
    ["image/gif", Array.from(Buffer.from("GIF00a"))],
    ["image/webp", [1]],
    ["image/webp", Array.from(Buffer.from("NOPE0000WEBP"))],
    ["image/webp", Array.from(Buffer.from("RIFF0000NOPE"))],
  ])("rejects invalid %s signatures", async (mimeType, data) => {
    const bytes = Uint8Array.from(data);
    mocks.attachmentFindMany.mockResolvedValue([
      stored({ mimeType, size: bytes.length }),
    ]);
    mocks.readAttachment.mockReturnValue(stream(bytes));
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("hydrates JSON text and reads repeated references only once", async () => {
    mocks.attachmentFindMany.mockResolvedValue([
      stored({ mimeType: "Application/Problem+JSON" }),
    ]);
    mocks.readAttachment.mockReturnValue(
      stream(new TextEncoder().encode("true")),
    );
    const result = await hydrateWorkspaceAttachmentMessages(
      [
        {
          role: "user",
          parts: [
            { type: "text", text: "Question" },
            ...fileMessages[0].parts,
            ...fileMessages[0].parts,
          ],
        },
      ],
      hydrationInput,
    );
    expect(result[0].parts).toEqual([
      { type: "text", text: "Question" },
      {
        type: "text",
        text: '[Begin attachment "file.txt"]\ntrue\n[End attachment "file.txt"]',
      },
      {
        type: "text",
        text: '[Begin attachment "file.txt"]\ntrue\n[End attachment "file.txt"]',
      },
    ]);
    expect(mocks.readAttachment).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5])(
    "rejects corrupt stored byte counts %s",
    async (size) => {
      mocks.attachmentFindMany.mockResolvedValue([stored({ size })]);
      await expect(
        hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
      ).rejects.toMatchObject({ status: 500 });
      expect(mocks.readAttachment).not.toHaveBeenCalled();
    },
  );

  it("distinguishes missing scope, incomplete bytes, invalid UTF-8 and storage failures", async () => {
    mocks.attachmentFindMany.mockResolvedValueOnce([]);
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({ status: 409 });
    mocks.attachmentFindMany.mockResolvedValue([stored()]);
    mocks.readAttachment.mockReturnValueOnce(stream(new Uint8Array([1])));
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({
      status: 502,
      message: "Attachment storage returned incomplete data.",
    });
    mocks.readAttachment.mockReturnValueOnce(
      stream(new Uint8Array([255, 255, 255, 255])),
    );
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({ status: 415 });
    mocks.readAttachment.mockImplementationOnce(() => {
      throw new Error("private path");
    });
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({
      status: 502,
      message: "Attachment storage is unavailable.",
    });
  });

  it("enforces model byte and text limits before returning any hydrated message", async () => {
    mocks.attachmentFindMany.mockResolvedValueOnce([
      stored({ size: 20 * 1024 * 1024 + 1 }),
    ]);
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({
      status: 413,
      message: "Attachments exceed the 20 MB model input limit.",
    });
    expect(mocks.readAttachment).not.toHaveBeenCalled();
    mocks.attachmentFindMany.mockResolvedValueOnce([stored({ size: 200001 })]);
    mocks.readAttachment.mockReturnValueOnce(
      stream(new TextEncoder().encode("a".repeat(200001))),
    );
    await expect(
      hydrateWorkspaceAttachmentMessages(fileMessages, hydrationInput),
    ).rejects.toMatchObject({
      status: 413,
      message:
        "Text attachments exceed the 200,000 character model input limit.",
    });
  });

  it("accepts only exact internal attachment URLs and enforces five files", () => {
    expect(
      attachmentIdsFromParts([
        { type: "file", url: "/api/v1/attachments/attachment-1" },
      ]),
    ).toEqual(["attachment-1"]);
    expect(() =>
      attachmentIdsFromParts([
        {
          type: "file",
          url: "https://toolplane.test/api/v1/attachments/attachment-1",
        },
      ]),
    ).toThrow(AttachmentMessageError);
    expect(() =>
      attachmentIdsFromParts([
        { type: "file", url: "/api/v1/attachments/attachment-1?download=1" },
      ]),
    ).toThrow(AttachmentMessageError);
    expect(() =>
      attachmentIdsFromParts(
        Array.from({ length: 6 }, (_, index) => ({
          type: "file",
          url: `/api/v1/attachments/attachment-${index}`,
        })),
      ),
    ).toThrow(/at most 5/);
  });

  it("rejects an attachment already claimed by another conversation", async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1",
          uploadedById: "user-1",
          chatThreadId: null,
          conversationId: "conversation-2",
        }),
      },
    };

    await expect(
      claimWorkspaceAttachments(tx as never, {
        ids: ["attachment-1"],
        workspaceId: "workspace-1",
        uploadedById: "user-1",
        scope: { conversationId: "conversation-1" },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows an idempotent claim for the same conversation", async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1",
          uploadedById: "user-1",
          chatThreadId: null,
          conversationId: "conversation-1",
        }),
      },
    };

    await expect(
      claimWorkspaceAttachments(tx as never, {
        ids: ["attachment-1"],
        workspaceId: "workspace-1",
        uploadedById: "user-1",
        scope: { conversationId: "conversation-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an attachment from another workspace or uploader", async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: "workspace-2",
          uploadedById: "user-2",
          chatThreadId: null,
          conversationId: null,
        }),
      },
    };

    await expect(
      claimWorkspaceAttachments(tx as never, {
        ids: ["attachment-1"],
        workspaceId: "workspace-1",
        uploadedById: "user-1",
        scope: { chatThreadId: "thread-1" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("hydrates a magic-checked PNG as transient Pi image data", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    mocks.attachmentFindMany.mockResolvedValue([
      stored({
        name: "shot.png",
        mimeType: "image/png",
        size: png.byteLength,
      }),
    ]);
    mocks.readAttachment.mockReturnValue(stream(png));

    const [message] = await hydrateWorkspaceAttachmentMessages(
      [
        {
          role: "user",
          parts: [{ type: "file", url: "/api/v1/attachments/attachment-1" }],
        },
      ],
      {
        workspaceId: "workspace-1",
        scope: { conversationId: "conversation-1" },
      },
    );

    expect(message.parts).toEqual([
      { type: "text", text: '[Attached image: "shot.png"]' },
      {
        type: "image",
        data: Buffer.from(png).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("rejects image bytes that do not match the declared MIME type", async () => {
    const bytes = new TextEncoder().encode("not a png");
    mocks.attachmentFindMany.mockResolvedValue([
      stored({
        name: "fake.png",
        mimeType: "image/png",
        size: bytes.byteLength,
      }),
    ]);
    mocks.readAttachment.mockReturnValue(stream(bytes));

    await expect(
      hydrateWorkspaceAttachmentMessages(
        [
          {
            role: "user",
            parts: [{ type: "file", url: "/api/v1/attachments/attachment-1" }],
          },
        ],
        {
          workspaceId: "workspace-1",
          scope: { chatThreadId: "thread-1" },
        },
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects PDF instead of silently dropping it", async () => {
    mocks.attachmentFindMany.mockResolvedValue([
      stored({
        name: "report.pdf",
        mimeType: "application/pdf",
      }),
    ]);

    await expect(
      hydrateWorkspaceAttachmentMessages(
        [
          {
            role: "user",
            parts: [{ type: "file", url: "/api/v1/attachments/attachment-1" }],
          },
        ],
        {
          workspaceId: "workspace-1",
          scope: { conversationId: "conversation-1" },
        },
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect(mocks.readAttachment).not.toHaveBeenCalled();
  });
});
