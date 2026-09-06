import { EventEmitter } from 'node:events';
import type { FileAttachment, ImageAttachment } from './media';
import type { ChannelLogger } from './logger';

export type ChannelConfigs = {
  telegram: { bot_token: string; allowed_chat_ids?: string[] };
  feishu: { app_id: string; app_secret: string; encrypt_key: string; verification_token: string; domain: 'feishu' | 'lark'; allowed_chat_ids?: string[] };
  qq: { app_id: string; client_secret: string; mention_only?: boolean; allowed_chat_ids?: string[] };
  wechat: { token: string; accountId: string; baseUrl?: string; allowed_chat_ids?: string[] };
  discord: { bot_token: string; allowed_channel_ids?: string[] };
  slack: { bot_token: string; app_token: string; allowed_channel_ids?: string[] };
};
export type ChannelAdapterConfig<T extends keyof ChannelConfigs = keyof ChannelConfigs> = {
  channelId: string;
  channelType: T;
  agentId: string;
  channelConfig: ChannelConfigs[T];
};
export type ChannelMessageEvent = {
  chatId: string;
  conversationId?: string;
  userId: string;
  userName: string;
  text: string;
  messageId?: string;
  replyInThread?: boolean;
  roleIds?: string[];
  images?: ImageAttachment[];
  files?: FileAttachment[];
};
export type ChannelCommandEvent = Omit<ChannelMessageEvent, 'text'> & { command: 'new' | 'compact' | 'help' | 'whoami'; args?: string };
export type SendMessageOptions = { parseMode?: 'MarkdownV2' | 'HTML'; replyToMessageId?: string | number; replyInThread?: boolean };
export type ChannelStatusEvent = { connected: boolean; error?: string };
export type ChannelLogEvent = { level: keyof ChannelLogger; message: string };

// Same adapter lifecycle as Cherry; persistence and Agent execution stay in ToolPlane.
export abstract class ChannelAdapter extends EventEmitter {
  readonly channelId: string;
  readonly agentId: string;
  readonly channelType: keyof ChannelConfigs;
  notifyChatIds: string[] = [];
  private controller: AbortController | null = null;
  private isConnected = false;
  protected readonly log: ChannelLogger;

  constructor(protected readonly config: ChannelAdapterConfig) {
    super();
    this.channelId = config.channelId;
    this.agentId = config.agentId;
    this.channelType = config.channelType;
    const log = (level: keyof ChannelLogger) => (message: string, meta?: unknown) => {
      const error = meta && typeof meta === 'object' && 'error' in meta ? meta.error : undefined;
      this.emit('log', { level, message: error ? `${message}: ${String(error)}` : message });
    };
    this.log = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  }

  get connected() { return this.isConnected; }
  protected markConnected() {
    if (this.controller?.signal.aborted || this.isConnected) return;
    this.isConnected = true;
    this.emit('statusChange', { connected: true });
  }
  protected markDisconnected(error?: string) {
    this.isConnected = false;
    this.emit('statusChange', { connected: false, error });
  }
  async connect() {
    this.controller = new AbortController();
    if (!await this.checkReady()) throw new Error('Complete channel credentials before connecting.');
    await this.performConnect(this.controller.signal);
  }
  async disconnect() {
    this.controller?.abort();
    this.isConnected = false;
    await this.performDisconnect();
  }
  protected async checkReady(): Promise<boolean> { return true; }
  protected abstract performConnect(signal: AbortSignal): Promise<void>;
  protected abstract performDisconnect(): Promise<void>;
  abstract sendMessage(chatId: string, text: string, opts?: SendMessageOptions): Promise<void>;
  abstract sendTypingIndicator(chatId: string, opts?: SendMessageOptions): Promise<void>;
  /* eslint-disable @typescript-eslint/no-unused-vars -- Optional hooks share the upstream adapter signatures. */
  async sendFile(_chatId: string, _file: FileAttachment): Promise<void> { throw new Error('File delivery is not supported.'); }
  async onTextUpdate(_chatId: string, _text: string, _opts?: SendMessageOptions): Promise<void> {}
  async onStreamComplete(_chatId: string, _text: string, _opts?: SendMessageOptions): Promise<boolean> { return false; }
  async onStreamError(_chatId: string, _error: string, _opts?: SendMessageOptions): Promise<void> {}
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
