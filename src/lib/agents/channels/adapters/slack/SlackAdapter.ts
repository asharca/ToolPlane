// Adapted from Cherry Studio. See NOTICE for source and license.
import { getTransportSettings } from "@/lib/admin/transport-settings";
import {
  type FileAttachment,
  type ImageAttachment,
  MAX_FILE_SIZE_BYTES,
} from "../../media";
import { streamTail } from "../../text";
import { channelFetch as fetch, sanitizeRemoteUrl } from "../../http";
import WebSocket from "ws";

import {
  ChannelAdapter,
  type ChannelAdapterConfig,
  type ChannelAdmissionReceipt,
  type ChannelMessageEvent,
  type SendMessageOptions,
} from "../../ChannelAdapter";
import { isSlashCommand, MAX_INBOUND_PAYLOAD_BYTES } from "../../constants";
import { FlushController } from "../../FlushController";
import { splitMessage } from "../../utils";
import { toSlackMarkdown } from "./slackMarkdown";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_MAX_LENGTH = 4000;

/**
 * Slack rate limit for chat.update: ~1 per second per channel.
 * Use 1500ms throttle to stay safely within limits.
 */
const SLACK_STREAM_THROTTLE_MS = 1500;

// ─── Slack Types ──────────────────────────────────────────────

type SlackFile = {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
};

type SlackMessageEvent = {
  type: "message";
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  files?: SlackFile[];
  ts: string;
  thread_ts?: string;
  channel_type?: string; // 'im' for DMs, 'channel'/'group' for channels
};

type SlackSocketEnvelope = {
  envelope_id: string;
  type:
    | "events_api"
    | "slash_commands"
    | "interactive"
    | "hello"
    | "disconnect";
  payload?: {
    event_id?: string;
    event?: SlackMessageEvent;
    command?: string;
    text?: string;
    user_id?: string;
    user_name?: string;
    channel_id?: string;
    channel_name?: string;
  };
  retry_attempt?: number;
  retry_reason?: string;
};

// ─── Streaming Controller ─────────────────────────────────────

/**
 * Manages a single streaming response by creating a message, then
 * editing it in-place with throttled updates via FlushController.
 */
class SlackStreamingController {
  private messageTs: string | null = null;
  private currentText = "";
  private readonly flush: FlushController;
  private messageCreationPromise: Promise<void> | null = null;
  private _completed = false;

  constructor(
    private readonly channelId: string,
    private readonly apiRequest: SlackAdapter["apiRequest"],
    private readonly log: Record<
      string,
      (msg: string, meta?: Record<string, unknown>) => void
    >,
  ) {
    this.flush = new FlushController(() => this.performFlush());
  }

  get completed(): boolean {
    return this._completed;
  }

  async onText(text: string): Promise<void> {
    if (this._completed) return;
    this.currentText = text;
    await this.ensureMessageCreated();
    if (this.messageTs) {
      await this.flush.throttledUpdate(SLACK_STREAM_THROTTLE_MS);
    }
  }

  async complete(finalText: string): Promise<boolean> {
    if (this._completed) return false;
    this._completed = true;
    this.flush.complete();

    if (this.messageCreationPromise) await this.messageCreationPromise;
    if (!this.messageTs) return false;

    await this.flush.waitForFlush();

    // The streamed message becomes the first chunk; the rest follow, nothing is truncated.
    const [first = "", ...rest] = splitMessage(
      toSlackMarkdown(finalText),
      SLACK_MAX_LENGTH,
    );
    try {
      this.currentText = finalText;
      await this.editMessage(first);
    } catch (error) {
      this.log.warn("Failed to finalize Slack stream", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    for (const chunk of rest)
      await this.apiRequest("chat.postMessage", {
        channel: this.channelId,
        text: chunk,
      });
    return true;
  }

  async error(errorMessage: string): Promise<void> {
    if (this._completed) return;
    this._completed = true;
    this.flush.complete();

    if (this.messageCreationPromise) await this.messageCreationPromise;
    if (!this.messageTs) return;

    await this.flush.waitForFlush();

    try {
      const displayText = this.currentText
        ? `${this.currentText}\n\n---\n**Error**: ${errorMessage}`
        : `**Error**: ${errorMessage}`;
      await this.editMessage(
        streamTail(toSlackMarkdown(displayText), SLACK_MAX_LENGTH),
      );
    } catch {
      // Best-effort error update
    }
  }

  dispose(): void {
    this._completed = true;
    this.flush.cancelPendingFlush();
    this.flush.complete();
  }

  // ---- Internal ----

  private async ensureMessageCreated(): Promise<void> {
    if (this.messageTs) return;
    if (this.messageCreationPromise) {
      await this.messageCreationPromise;
      return;
    }
    this.messageCreationPromise = this.createMessage();
    await this.messageCreationPromise;
  }

  private async createMessage(): Promise<void> {
    try {
      const data = await this.apiRequest("chat.postMessage", {
        channel: this.channelId,
        text:
          streamTail(toSlackMarkdown(this.currentText), SLACK_MAX_LENGTH) ||
          "...",
      });
      this.messageTs = (data as { ts?: string }).ts ?? null;
    } catch (error) {
      this.log.warn("Failed to create Slack streaming message", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** `content` is Slack markdown that already fits one message. */
  private async editMessage(content: string): Promise<void> {
    if (!this.messageTs) return;
    await this.apiRequest("chat.update", {
      channel: this.channelId,
      ts: this.messageTs,
      text: content,
    });
  }

  private async performFlush(): Promise<void> {
    if (!this.messageTs || !this.currentText) return;
    try {
      await this.editMessage(
        streamTail(toSlackMarkdown(this.currentText), SLACK_MAX_LENGTH),
      );
    } catch {
      // Swallow flush errors — FlushController will reflush if needed
    }
  }
}

// ─── Slack Adapter ────────────────────────────────────────────

export class SlackAdapter extends ChannelAdapter {
  private ws: WebSocket | null = null;
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly allowedChannelIds: string[];

  private botUserId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldStop = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** User info cache: Slack user ID → display name */
  private readonly userNameCache = new Map<string, string>();

  private readonly reconnectDelays = [1000, 2000, 5000, 10000, 30000, 60000];
  private readonly maxReconnectAttempts = 50;
  private readonly streamingControllers = new Map<
    string,
    SlackStreamingController
  >();
  /** Track the latest incoming message ts per chatId for reaction acknowledgment */
  private readonly pendingReactions = new Map<string, string>();

  constructor(config: ChannelAdapterConfig<"slack">) {
    super(config);
    const { bot_token, app_token, allowed_channel_ids } = config.channelConfig;
    this.botToken = bot_token;
    this.appToken = app_token;
    this.allowedChannelIds = allowed_channel_ids ?? [];
    this.notifyChatIds = [...this.allowedChannelIds];
  }

  protected override async checkReady(): Promise<boolean> {
    return !!(this.botToken && this.appToken);
  }

  protected override async performConnect(): Promise<void> {
    if (!this.botToken)
      throw new Error("Slack bot token (xoxb-...) is required");
    if (!this.appToken)
      throw new Error(
        "Slack app-level token (xapp-...) is required for Socket Mode",
      );
    this.shouldStop = false;
    await this.fetchBotUserId();
    await this.startSocketMode();
    this.log.info("Slack bot started");
  }

  protected override async performDisconnect(): Promise<void> {
    this.shouldStop = true;
    for (const controller of this.streamingControllers.values()) {
      controller.dispose();
    }
    this.streamingControllers.clear();
    this.pendingReactions.clear();
    this.cleanup();
    this.log.info("Slack bot stopped");
  }

  // ─── Socket Mode Connection ─────────────────────────────────

  private async fetchBotUserId(): Promise<void> {
    try {
      const data = (await this.apiRequest("auth.test", {})) as {
        user_id?: string;
      };
      this.botUserId = data.user_id ?? null;
      this.log.info("Slack bot identity resolved", {
        botUserId: this.botUserId,
      });
    } catch (error) {
      this.log.warn("Failed to resolve bot user ID", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getSocketModeUrl(): Promise<string> {
    const response = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to open Socket Mode connection: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      ok: boolean;
      url?: string;
      error?: string;
    };
    if (!data.ok || !data.url) {
      throw new Error(
        `Socket Mode connection failed: ${data.error ?? "no URL returned"}`,
      );
    }

    return data.url;
  }

  private async startSocketMode(): Promise<void> {
    if (this.shouldStop) return;

    try {
      this.cleanup();

      const wsUrl = await this.getSocketModeUrl();
      if (this.shouldStop) return;
      this.log.info("Connecting to Slack Socket Mode");

      const ws = new WebSocket(
        sanitizeRemoteUrl(wsUrl, true, await getTransportSettings()),
      );
      this.ws = ws;

      ws.on("open", () => {
        this.log.info("Slack WebSocket connected");
        // Slack Socket Mode requires periodic pings to keep alive
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 30_000);
      });

      ws.on("message", (data: Buffer) => {
        this.handleSocketMessage(data, ws).catch(() => {
          this.log.error("Slack event admission failed");
        });
      });

      ws.on("close", (code, reason) => {
        this.markDisconnected(`WebSocket closed: ${code}`);
        this.log.warn(
          `WebSocket closed (code=${code}, reason=${reason.toString()})`,
        );
        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        this.log.error("Slack WebSocket error", { error: err.message });
      });
    } catch (error) {
      this.log.error("Failed to start Slack Socket Mode", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  // ─── Socket Mode Message Handling ───────────────────────────

  private async handleSocketMessage(
    data: Buffer,
    socket = this.ws,
  ): Promise<void> {
    const deadline = performance.now() + 3000;
    let envelope: SlackSocketEnvelope;
    try {
      envelope = JSON.parse(data.toString());
    } catch {
      return;
    }

    const acknowledge = () => {
      if (
        envelope.envelope_id &&
        performance.now() < deadline &&
        socket?.readyState === WebSocket.OPEN
      )
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    };
    if (envelope.type !== "events_api") acknowledge();

    switch (envelope.type) {
      case "hello":
        this.reconnectAttempts = 0;
        this.markConnected();
        this.log.info("Slack Socket Mode hello received");
        break;
      case "disconnect":
        this.log.info("Slack requested disconnect, will reconnect");
        this.ws?.close(1000, "Server requested disconnect");
        break;
      case "events_api":
        if (envelope.payload?.event) {
          this.handleEvent(envelope.payload.event, {
            dedupeKey: envelope.payload.event_id,
            acknowledge,
          });
        } else acknowledge();
        break;
      case "slash_commands":
        if (envelope.payload) {
          await this.handleSlashCommand(envelope.payload, envelope.envelope_id);
        }
        break;
    }
  }

  private handleEvent(
    event: SlackMessageEvent,
    receipt: ChannelAdmissionReceipt,
  ) {
    if (
      event.type !== "message" ||
      (event.subtype && event.subtype !== "file_share") ||
      (event.user && event.user === this.botUserId)
    )
      return receipt.acknowledge();

    const chatId = event.channel;
    if (!this.isAllowed(chatId)) return receipt.acknowledge();

    const userId = event.user ?? "";
    const userName = userId;
    const threadId =
      event.thread_ts && event.thread_ts !== event.ts
        ? event.thread_ts
        : undefined;
    const context = {
      chatType: threadId
        ? "thread"
        : event.channel_type === "im"
          ? "dm"
          : event.channel_type === "mpim"
            ? "group"
            : "channel",
      threadId,
      replyInThread: Boolean(threadId),
    };

    // Strip bot mentions from text
    const rawText = event.text ?? "";
    const text = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

    // Store stable file IDs. Profile lookups and authenticated downloads run after ACK.
    const slackFileIds = event.files
      ?.filter((file) => file.size <= MAX_FILE_SIZE_BYTES)
      .slice(0, 20)
      .map((file) => file.id);
    if (!text && !slackFileIds?.length) return receipt.acknowledge();

    if (isSlashCommand(text)) {
      const cmd = text.split(/\s+/)[0].slice(1) as
        | "new"
        | "compact"
        | "help"
        | "whoami";
      this.emit(
        "command",
        {
          chatId,
          ...context,
          userId,
          userName,
          messageId: event.ts,
          command: cmd,
          args: text.split(/\s+/).slice(1).join(" "),
        },
        receipt,
      );
    } else {
      this.emit(
        "message",
        {
          chatId,
          ...context,
          userId,
          userName,
          messageId: event.ts,
          text,
          slackFileIds,
        },
        receipt,
      );
    }
  }

  override async hydrateInbound(
    event: ChannelMessageEvent,
  ): Promise<ChannelMessageEvent> {
    const userName = await this.resolveUserName(event.userId);
    if (!event.slackFileIds?.length) return { ...event, userName };
    const images: ImageAttachment[] = [];
    const files: FileAttachment[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(event));
    for (const id of event.slackFileIds) {
      const { file } = (await this.apiRequest("files.info", { file: id })) as {
        file: SlackFile;
      };
      if (bytes + 4 * Math.ceil(file.size / 3) > MAX_INBOUND_PAYLOAD_BYTES)
        throw new Error(
          "Channel inbound payload exceeds the attachment limit.",
        );
      if (file.mimetype.startsWith("image/")) {
        const image = await this.downloadSlackFile(file.url_private);
        if (!image) throw new Error("Slack attachment download failed.");
        bytes += image.data.length;
        images.push(image);
      } else {
        const attachment = await this.downloadSlackFileAsAttachment(
          file.url_private,
          file.name,
        );
        if (!attachment) throw new Error("Slack attachment download failed.");
        bytes += attachment.data.length;
        files.push(attachment);
      }
      if (bytes > MAX_INBOUND_PAYLOAD_BYTES)
        throw new Error(
          "Channel inbound payload exceeds the attachment limit.",
        );
    }
    return { ...event, userName, images, files };
  }

  private async handleSlashCommand(
    payload: NonNullable<SlackSocketEnvelope["payload"]>,
    envelopeId: string,
  ): Promise<void> {
    const command = payload.command?.replace("/", "") ?? "";
    const chatId = payload.channel_id ?? "";
    const userId = payload.user_id ?? "";
    const userName = payload.user_name ?? "";

    if (!chatId) return;
    if (!this.isAllowed(chatId)) return;

    if (command) {
      this.emit("command", {
        chatId,
        chatType: payload.channel_name === "directmessage" ? "dm" : "channel",
        userId,
        userName,
        messageId: envelopeId,
        command: command as "new" | "compact" | "help",
        args: payload.text,
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private isAllowed(chatId: string): boolean {
    if (this.allowedChannelIds.length === 0) return true;
    return this.allowedChannelIds.includes(chatId);
  }

  private async resolveUserName(userId: string): Promise<string> {
    if (!userId) return "";
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const data = (await this.apiRequest("users.info", { user: userId })) as {
        user?: { real_name?: string; name?: string };
      };
      const name = data.user?.real_name || data.user?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /**
   * Download a Slack private file URL using bot token authorization.
   * Slack file URLs (url_private) require Bearer auth.
   */
  private async downloadSlackFile(
    url: string,
  ): Promise<ImageAttachment | null> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      if (!response.ok) return null;
      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        Number.parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES
      )
        return null;
      const contentType = response.headers.get("content-type") || "image/png";
      const mediaType = contentType.split(";")[0].trim();
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FILE_SIZE_BYTES) return null;
      return { data: buffer.toString("base64"), media_type: mediaType };
    } catch {
      return null;
    }
  }

  private async downloadSlackFileAsAttachment(
    url: string,
    filename: string,
  ): Promise<FileAttachment | null> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FILE_SIZE_BYTES) return null;
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const mediaType = contentType.split(";")[0].trim();
      return {
        filename,
        data: buffer.toString("base64"),
        media_type: mediaType,
        size: buffer.length,
      };
    } catch {
      return null;
    }
  }

  // ─── Message Sending (Web API) ──────────────────────────────

  // Shared adapter signature.
  async sendMessage(
    chatId: string,
    text: string,
    _opts?: SendMessageOptions,
  ): Promise<void> {
    await this.removeReaction(chatId);

    const mrkdwn = toSlackMarkdown(text);
    const chunks = splitMessage(mrkdwn, SLACK_MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      await this.apiRequest("chat.postMessage", {
        channel: chatId,
        text: chunks[i],
      });

      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  // Shared adapter signature.
  async sendTypingIndicator(
    chatId: string,
    opts?: SendMessageOptions,
  ): Promise<void> {
    if (opts?.replyToMessageId)
      await this.addReaction(chatId, String(opts.replyToMessageId));
  }

  // ─── Streaming ─────────────────────────────────────────────

  override async onTextUpdate(chatId: string, fullText: string): Promise<void> {
    let controller = this.streamingControllers.get(chatId);
    if (!controller || controller.completed) {
      controller = new SlackStreamingController(
        chatId,
        this.apiRequest.bind(this),
        this.log,
      );
      this.streamingControllers.set(chatId, controller);
    }
    await controller.onText(fullText);
  }

  override async onStreamComplete(
    chatId: string,
    finalText: string,
  ): Promise<boolean> {
    const controller = this.streamingControllers.get(chatId);
    if (!controller) return false;
    try {
      await this.removeReaction(chatId);
      return await controller.complete(finalText);
    } finally {
      this.streamingControllers.delete(chatId);
    }
  }

  override async onStreamError(chatId: string, error: string): Promise<void> {
    const controller = this.streamingControllers.get(chatId);
    if (!controller) return;
    try {
      await this.removeReaction(chatId);
      await controller.error(error);
    } finally {
      this.streamingControllers.delete(chatId);
    }
  }

  // ─── Reaction Acknowledgment ────────────────────────────────

  private async addReaction(chatId: string, ts: string): Promise<void> {
    try {
      await this.apiRequest("reactions.add", {
        channel: chatId,
        name: "eyes",
        timestamp: ts,
      });
      this.pendingReactions.set(chatId, ts);
    } catch {
      // Best-effort — don't fail message handling if reaction fails
    }
  }

  private async removeReaction(chatId: string): Promise<void> {
    const ts = this.pendingReactions.get(chatId);
    if (!ts) return;
    this.pendingReactions.delete(chatId);
    try {
      await this.apiRequest("reactions.remove", {
        channel: chatId,
        name: "eyes",
        timestamp: ts,
      });
    } catch {
      // Best-effort removal
    }
  }

  // ─── Slack Web API Helper ──────────────────────────────────

  private async apiRequest(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Slack API error ${method}: HTTP ${response.status} - ${errorText}`,
      );
    }

    const data = (await response.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(
        `Slack API error ${method}: ${data.error ?? "unknown error"}`,
      );
    }

    return data;
  }

  // ─── Lifecycle Helpers ──────────────────────────────────────

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.shouldStop) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("fatal", "Slack reconnect attempts exhausted.", {
        restart: true,
      });
      return;
    }

    const delay =
      this.reconnectDelays[
        Math.min(this.reconnectAttempts, this.reconnectDelays.length - 1)
      ];
    this.reconnectAttempts++;

    this.log.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldStop) {
        this.startSocketMode().catch((err) => {
          this.log.error("Reconnect failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }, delay);
  }
}
