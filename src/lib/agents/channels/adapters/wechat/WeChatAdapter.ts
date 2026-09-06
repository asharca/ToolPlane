import { ChannelAdapter, type ChannelAdapterConfig } from '../../ChannelAdapter';
import { FILE_EXTENSION_MIME_MAP, splitMessage } from '../../utils';
import type { FileAttachment, ImageAttachment } from '../../media';
import { WeixinBot } from './WeChatProtocol';

// Cherry's iLink transport, with credentials supplied by ToolPlane's encrypted DB.
export class WeChatAdapter extends ChannelAdapter {
  private bot: WeixinBot | null = null;
  constructor(private readonly options: ChannelAdapterConfig<'wechat'>) { super(options); }

  protected async performConnect(signal: AbortSignal) {
    const config = this.options.channelConfig;
    if (!config.token || !config.accountId) throw new Error('Scan the WeChat login QR code first.');
    const bot = new WeixinBot({
      credentials: { token: config.token, accountId: config.accountId, userId: '', baseUrl: config.baseUrl || 'https://ilinkai.weixin.qq.com' },
      onConnected: () => this.markConnected(),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.markDisconnected(message);
        this.log.error('WeChat polling failed', { error: message });
      },
      log: this.log,
    });
    this.bot = bot;
    bot.onMessage(async (message) => {
      if (signal.aborted) return;
      const allowed = config.allowed_chat_ids ?? [];
      if (allowed.length && !allowed.includes(message.userId)) return;
      const images: ImageAttachment[] = [];
      for (const item of message._imageItems ?? []) {
        const data = await bot.downloadImage(item);
        const match = data?.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
        if (match) images.push({ media_type: match[1], data: match[2] });
      }
      const files = [];
      for (const item of message._fileItems ?? []) {
        const file = await bot.downloadFile(item);
        if (file) files.push({ filename: file.filename, data: file.data.toString('base64'), size: file.data.length,
          media_type: file.mediaType === 'application/octet-stream'
            ? FILE_EXTENSION_MIME_MAP[file.filename.split('.').at(-1)?.toLowerCase() ?? ''] || file.mediaType : file.mediaType });
      }
      if (signal.aborted || (!message.text.trim() && !images.length && !files.length)) return;
      this.emit('message', { chatId: message.userId, userId: message.userId, userName: message.userId,
        messageId: message.messageId, text: message.text, images, files });
    });
    void bot.run().catch((error: unknown) => {
      if (!signal.aborted) this.emit('fatal', error instanceof Error ? error.message : 'WeChat connection failed.');
    });
    this.log.info('WeChat iLink polling started.');
  }
  protected async performDisconnect() {
    await this.bot?.stop();
    this.bot = null;
  }
  async sendMessage(chatId: string, text: string) {
    const bot = this.bot;
    if (!bot) throw new Error('WeChat is not connected.');
    try {
      for (const chunk of splitMessage(text, 2000)) await bot.send(chatId, chunk);
    } finally { await bot.stopTyping(chatId).catch(() => {}); }
  }
  async sendTypingIndicator(chatId: string) { await this.bot?.sendTyping(chatId); }
  override async sendFile(chatId: string, file: FileAttachment) {
    if (!this.bot) throw new Error('WeChat is not connected.');
    await this.bot.sendFile(chatId, file.filename, Buffer.from(file.data, 'base64'), file.media_type);
  }
}
