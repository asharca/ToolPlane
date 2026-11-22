import "server-only";
import { readWorkspaceAttachment } from "@/lib/attachments/storage";
import { db } from "@/lib/db";
import type {
  ChannelAdapter,
  SendMessageOptions,
} from "./channels/ChannelAdapter";
import type { ChannelReplyFile } from "./message-service";

export const CHANNEL_FILE_DELIVERY_MAX_BYTES = 20 * 1024 * 1024;
export const CHANNEL_FILE_DELIVERY_MAX_FILES = 10;

export async function deliverChannelReplyFiles({
  adapter,
  chatId,
  workspaceId,
  files,
  fallbackFilenames = [],
  detailUrl,
  options,
  log,
}: {
  adapter: Pick<
    ChannelAdapter,
    "supportsFileDelivery" | "sendFile" | "sendMessage"
  >;
  chatId: string;
  workspaceId: string;
  files: ChannelReplyFile[];
  fallbackFilenames?: string[];
  detailUrl?: string;
  options: SendMessageOptions;
  log: (level: "warn", message: string) => void;
}): Promise<void> {
  if (!files.length && !fallbackFilenames.length) return;

  const undelivered: string[] = [];
  if (files.length) {
    const rows = await db.workspaceAttachment.findMany({
      where: {
        id: { in: files.map((file) => file.attachmentId) },
        workspaceId,
        status: "ready",
        origin: "artifact",
        uploaderOnly: false,
      },
      select: {
        id: true,
        storagePath: true,
        name: true,
        mimeType: true,
        size: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [index, file] of files.entries()) {
      const row = byId.get(file.attachmentId);
      // An out-of-scope artifact must not be disclosed, even by name.
      if (!row) continue;
      if (
        adapter.supportsFileDelivery &&
        index < CHANNEL_FILE_DELIVERY_MAX_FILES &&
        row.size > 0 &&
        row.size <= CHANNEL_FILE_DELIVERY_MAX_BYTES
      ) {
        try {
          const stream = readWorkspaceAttachment(
            workspaceId,
            row.storagePath,
            row.size,
          );
          const bytes = Buffer.from(await new Response(stream).arrayBuffer());
          if (bytes.length !== row.size)
            throw new Error("Attachment size mismatch.");
          await adapter.sendFile(chatId, {
            data: bytes.toString("base64"),
            media_type: row.mimeType,
            filename: row.name,
            size: row.size,
          });
          continue;
        } catch {
          // Transport errors may include request bodies; never log their contents.
          log("warn", `Channel file delivery failed for attachment ${row.id}.`);
        }
      }
      undelivered.push(row.name);
    }
  }

  undelivered.push(...fallbackFilenames);
  if (!undelivered.length) return;
  const names = undelivered
    .slice(0, CHANNEL_FILE_DELIVERY_MAX_FILES)
    .join("、");
  const suffix =
    undelivered.length > CHANNEL_FILE_DELIVERY_MAX_FILES ? "等" : "";
  const link = detailUrl ? `\n在 ToolPlane 中查看（需登录）：${detailUrl}` : "";
  await adapter.sendMessage(
    chatId,
    `已生成 ${undelivered.length} 个文件：${names}${suffix}${link}`,
    options,
  );
}
