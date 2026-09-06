// Adapted from Cherry Studio. See NOTICE for source and license.
/**
 * WeChat iLink Bot protocol implementation.
 *
 * Inlined from @pinixai/weixin-bot to avoid the external dependency
 * and its fragile postinstall build step.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { loggerService, type ChannelLogger } from '../../logger'
import { MAX_FILE_SIZE_BYTES } from '../../media'
import { channelFetch as fetch } from '../../http'
import * as z from 'zod'

const logger = loggerService.withContext('WeChatProtocol')

// --------------- Types ---------------

interface BaseInfo {
  channel_version: string
}

enum MessageType {
  USER = 1,
  BOT = 2
}

enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2
}

enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5
}

interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

interface VoiceItem {
  media?: CDNMedia
  aeskey?: string
  encode_type?: number
  text?: string
}

interface FileItem {
  media?: CDNMedia
  aeskey?: string
  file_name?: string
  len?: string
}

interface VideoItem {
  media?: CDNMedia
  aeskey?: string
  video_size?: number
}

type DownloadableFileItem = FileItem | VoiceItem | VideoItem

interface RefMessage {
  title?: string
  message_item?: MessageItem
}

interface MessageItem {
  type: MessageItemType
  text_item?: { text: string }
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  ref_msg?: RefMessage
}

interface WeixinMessage {
  message_id: number | string
  from_user_id: string
  to_user_id: string
  client_id: string
  create_time_ms: number
  message_type: MessageType
  message_state: MessageState
  context_token: string
  item_list: MessageItem[]
}

export interface IncomingMessage {
  messageId: string
  userId: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  _contextToken: string
  timestamp: Date
  /** Raw image items from WeChat CDN (encrypted, need download+decrypt). */
  _imageItems?: ImageItem[]
  /** Raw non-image media items from WeChat CDN, normalized as workspace files. */
  _fileItems?: Array<{ filename: string; mediaType: string; item: DownloadableFileItem }>
}

// --------------- Zod response schemas ---------------

const ApiErrorBodySchema = z.object({
  ret: z.number().optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional()
})

const WeixinMessageSchema = z.object({
  message_id: z.union([z.number(), z.string()]),
  from_user_id: z.string(),
  to_user_id: z.string(),
  client_id: z.string(),
  create_time_ms: z.number(),
  message_type: z.number(),
  message_state: z.number(),
  context_token: z.string(),
  item_list: z.array(z.unknown())
})

const GetUpdatesRespSchema = z.object({
  msgs: z.array(WeixinMessageSchema).default([]),
  get_updates_buf: z.string().default('')
})

const GetConfigRespSchema = z.object({
  typing_ticket: z.string().optional()
})
type GetConfigResp = z.infer<typeof GetConfigRespSchema>

interface SendTypingReq {
  ilink_user_id: string
  typing_ticket: string
  status: 1 | 2
  base_info: BaseInfo
}

// --------------- Constants ---------------

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CHANNEL_VERSION = '1.0.0'
const MAX_CONTEXT_TOKENS = 1000

// --------------- AES-128-ECB helpers ---------------

function aesEcbDecrypt(encrypted: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/**
 * Resolve the 16-byte AES key from an image_item.
 * Priority: image_item.aeskey (hex) > image_item.media.aes_key (base64)
 */
function resolveImageAesKey(item: ImageItem): Buffer | null {
  if (item.aeskey) {
    return Buffer.from(item.aeskey, 'hex')
  }
  if (item.media?.aes_key) {
    return parseAesKey(item.media.aes_key)
  }
  return null
}

// --------------- CDN download ---------------

function resolveCdnDownloadUrl(media?: CDNMedia): string | null {
  const fullUrl = media?.full_url?.trim()
  if (fullUrl) {
    try {
      const url = new URL(fullUrl)
      if (url.protocol === 'https:' && url.hostname.endsWith('.cdn.weixin.qq.com')) return url.toString()
      logger.warn('Ignoring an untrusted WeChat CDN URL', { hostname: url.hostname })
    } catch {
      logger.warn('Ignoring an invalid WeChat CDN URL')
    }
  }
  if (!media?.encrypt_query_param) return null
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
}

async function cdnDownloadImage(item: ImageItem): Promise<Buffer | null> {
  const url = resolveCdnDownloadUrl(item.media)
  if (!url) return null

  const aesKey = resolveImageAesKey(item)
  if (!aesKey) {
    logger.warn('Image item has CDN media but no AES key')
    return null
  }

  const response = await fetch(url, { method: 'GET' })

  if (!response.ok) {
    return null
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
    logger.warn('Image too large, skipping CDN download', { size: contentLength })
    return null
  }

  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > MAX_FILE_SIZE_BYTES) {
    logger.warn('Image too large after CDN download', { size: encrypted.length })
    return null
  }
  return aesEcbDecrypt(encrypted, aesKey)
}

/**
 * Parse a CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings exist in the wild (per Tencent/openclaw-weixin):
 *   - base64(raw 16 bytes)            → images
 *   - base64(32-char hex ASCII string) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64: string): Buffer | null {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  logger.warn('Unexpected aes_key length after base64 decode', { length: decoded.length })
  return null
}

/**
 * Resolve the 16-byte AES key from a file_item.
 * Priority: file_item.aeskey (hex) > file_item.media.aes_key (base64, with hex re-decode for files)
 */
function resolveFileAesKey(item: DownloadableFileItem): Buffer | null {
  if (item.aeskey) {
    return Buffer.from(item.aeskey, 'hex')
  }
  if (item.media?.aes_key) {
    return parseAesKey(item.media.aes_key)
  }
  return null
}

async function cdnDownloadFile(item: DownloadableFileItem): Promise<Buffer | null> {
  const url = resolveCdnDownloadUrl(item.media)
  if (!url) return null

  const aesKey = resolveFileAesKey(item)
  if (!aesKey) {
    logger.warn('File item has CDN media but no AES key')
    return null
  }

  const response = await fetch(url, { method: 'GET' })

  if (!response.ok) {
    return null
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
    logger.warn('File too large, skipping CDN download', { size: contentLength })
    return null
  }

  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > MAX_FILE_SIZE_BYTES) {
    logger.warn('File too large after CDN download', { size: encrypted.length })
    return null
  }
  return aesEcbDecrypt(encrypted, aesKey)
}

// --------------- CDN upload ---------------

const GetUploadUrlRespSchema = z.object({
  upload_param: z.string().optional(),
  /** 官方较新的响应字段：服务端直接返回完整上传 URL，存在时优先直接 POST（无需客户端拼接）。 */
  upload_full_url: z.string().optional()
})

enum UploadMediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3
}

async function cdnUploadMedia(
  baseUrl: string,
  token: string,
  uin: string,
  toUserId: string,
  data: Buffer,
  mediaType: UploadMediaType
): Promise<{ downloadEncryptedQueryParam: string; aeskey: Buffer; ciphertextSize: number } | null> {
  const aeskey = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const md5Hash = await import('node:crypto').then((c) => c.createHash('md5').update(data).digest('hex'))
  // Declare the ciphertext size used by the CDN, so the metadata cannot drift from the upload body.
  const ciphertext = aesEcbEncrypt(data, aeskey)

  // Step 1: get upload URL
  const raw = await apiFetch(
    baseUrl,
    '/ilink/bot/getuploadurl',
    {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: data.length,
      rawfilemd5: md5Hash,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
      base_info: buildBaseInfo()
    },
    token,
    uin,
    15_000
  )
  const resp = GetUploadUrlRespSchema.parse(raw)
  const uploadFullUrl = resp.upload_full_url?.trim()
  const uploadParam = resp.upload_param
  if (!uploadFullUrl && !uploadParam) {
    logger.error('getuploadurl response missing both upload_full_url and upload_param')
    return null
  }

  // Step 2: upload（官方优先直接 POST upload_full_url，否则回退用 upload_param 拼接）
  const uploadUrl = uploadFullUrl
    ? uploadFullUrl
    : `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam!)}&filekey=${encodeURIComponent(filekey)}`
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext)
  })

  if (!uploadResp.ok) {
    logger.error('CDN upload failed', { status: uploadResp.status })
    return null
  }

  const downloadEncryptedQueryParam = uploadResp.headers.get('x-encrypted-param')
  if (!downloadEncryptedQueryParam) {
    logger.error('CDN upload response missing x-encrypted-param header')
    return null
  }

  return { downloadEncryptedQueryParam, aeskey, ciphertextSize: ciphertext.length }
}

// --------------- API helpers ---------------

class ApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly payload?: unknown

  constructor(message: string, options: { status: number; code?: number; payload?: unknown }) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.code = options.code
    this.payload = options.payload
  }
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

async function parseJsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  let raw: unknown
  try {
    raw = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`${label} returned non-JSON (HTTP ${response.status})`, {
      status: response.status,
      payload: text.slice(0, 200)
    })
  }

  if (!response.ok) {
    const body = ApiErrorBodySchema.safeParse(raw)
    const parsed = body.success ? body.data : {}
    throw new ApiError(parsed.errmsg ?? `${label} failed with HTTP ${response.status}`, {
      status: response.status,
      code: parsed.errcode,
      payload: raw
    })
  }

  const body = ApiErrorBodySchema.safeParse(raw)
  if (body.success && typeof body.data.ret === 'number' && body.data.ret !== 0) {
    throw new ApiError(body.data.errmsg ?? `${label} failed`, {
      status: response.status,
      code: body.data.errcode ?? body.data.ret,
      payload: raw
    })
  }

  return raw
}

function buildHeaders(token: string, uin: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': uin
  }
}

async function apiFetch(
  baseUrlOrigin: string,
  endpoint: string,
  body: unknown,
  token: string,
  uin: string,
  timeoutMs = 40_000,
  signal?: AbortSignal
): Promise<unknown> {
  const url = `${baseUrlOrigin}${endpoint}`
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, uin),
    body: JSON.stringify(body),
    signal: requestSignal
  })

  return parseJsonResponse(response, endpoint)
}

async function getUpdates(
  baseUrl: string,
  token: string,
  uin: string,
  buf: string,
  signal?: AbortSignal
): Promise<{ msgs: WeixinMessage[]; get_updates_buf: string }> {
  const raw = await apiFetch(
    baseUrl,
    '/ilink/bot/getupdates',
    { get_updates_buf: buf, base_info: buildBaseInfo() },
    token,
    uin,
    40_000,
    signal
  )
  const parsed = GetUpdatesRespSchema.parse(raw)
  return { msgs: parsed.msgs as WeixinMessage[], get_updates_buf: parsed.get_updates_buf }
}

async function apiSendMessage(
  baseUrl: string,
  token: string,
  uin: string,
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: MessageType
    message_state: MessageState
    context_token: string
    item_list: MessageItem[]
  }
): Promise<void> {
  await apiFetch(baseUrl, '/ilink/bot/sendmessage', { msg, base_info: buildBaseInfo() }, token, uin, 15_000)
}

async function apiGetConfig(
  baseUrl: string,
  token: string,
  uin: string,
  userId: string,
  contextToken: string
): Promise<GetConfigResp> {
  const raw = await apiFetch(
    baseUrl,
    '/ilink/bot/getconfig',
    { ilink_user_id: userId, context_token: contextToken, base_info: buildBaseInfo() },
    token,
    uin,
    15_000
  )
  return GetConfigRespSchema.parse(raw)
}

async function apiSendTyping(
  baseUrl: string,
  token: string,
  uin: string,
  userId: string,
  ticket: string,
  status: SendTypingReq['status']
): Promise<void> {
  const body: SendTypingReq = {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status,
    base_info: buildBaseInfo()
  }
  await apiFetch(baseUrl, '/ilink/bot/sendtyping', body, token, uin, 15_000)
}

async function apiNotifyLifecycle(baseUrl: string, token: string, uin: string, event: 'start' | 'stop'): Promise<void> {
  await apiFetch(baseUrl, `/ilink/bot/msg/notify${event}`, { base_info: buildBaseInfo() }, token, uin, 15_000)
}

function buildTextMessage(
  userId: string,
  contextToken: string,
  text: string
): {
  from_user_id: string
  to_user_id: string
  client_id: string
  message_type: MessageType
  message_state: MessageState
  context_token: string
  item_list: MessageItem[]
} {
  return {
    from_user_id: '',
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }]
  }
}

// --------------- WeixinBot ---------------

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

export type Credentials = { token: string; baseUrl: string; accountId: string; userId: string }

export interface WeixinBotOptions {
  credentials: Credentials
  onError?: (error: unknown) => void
  onConnected?: () => void
  log?: ChannelLogger
}

/** Normalize a base URL to origin form (no trailing slash). */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export class WeixinBot {
  private baseUrl: string
  private readonly uin: string
  private readonly onErrorCallback?: (error: unknown) => void
  private readonly handlers: MessageHandler[] = []
  private readonly contextTokens = new Map<string, string>()
  private readonly credentials: Credentials
  private readonly onConnected?: () => void
  private readonly logger: ChannelLogger
  private readonly stopController = new AbortController()
  private cursor = ''
  private stopped = false
  private currentPollController: AbortController | null = null
  private runPromise: Promise<void> | null = null

  constructor(options: WeixinBotOptions) {
    this.credentials = options.credentials
    this.baseUrl = normalizeBaseUrl(options.credentials.baseUrl || DEFAULT_BASE_URL)
    this.uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
    this.onErrorCallback = options.onError
    this.onConnected = options.onConnected
    this.logger = options.log ?? logger
  }

  onMessage(handler: MessageHandler): this {
    this.handlers.push(handler)
    return this
  }

  async reply(message: IncomingMessage, text: string): Promise<void> {
    this.contextTokens.set(message.userId, message._contextToken)
    await this.sendText(message.userId, text, message._contextToken)
    this.stopTyping(message.userId).catch(() => {})
  }

  async sendTyping(userId: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) return

    const credentials = await this.ensureCredentials()
    const config = await apiGetConfig(this.baseUrl, credentials.token, this.uin, userId, contextToken)
    if (!config.typing_ticket) return

    await apiSendTyping(this.baseUrl, credentials.token, this.uin, userId, config.typing_ticket, 1)
  }

  async stopTyping(userId: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) return

    const credentials = await this.ensureCredentials()
    const config = await apiGetConfig(this.baseUrl, credentials.token, this.uin, userId, contextToken)
    if (!config.typing_ticket) return

    await apiSendTyping(this.baseUrl, credentials.token, this.uin, userId, config.typing_ticket, 2)
  }

  async send(userId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      this.logger.warn('No cached context token, sending without context', { userId })
    }

    await this.sendText(userId, text, contextToken ?? '')
  }

  /**
   * Download and decrypt an image from WeChat CDN.
   * Returns a data URL (data:<mime>;base64,...) or null on failure.
   * Format conversion (to PNG) is handled downstream by ClaudeCodeService.
   */
  async downloadImage(imageItem: ImageItem): Promise<string | null> {
    try {
      const data = await cdnDownloadImage(imageItem)
      if (!data) return null

      const mime = detectImageMime(data)
      return `data:${mime};base64,${data.toString('base64')}`
    } catch (error) {
      this.logger.error('Failed to download WeChat image', error instanceof Error ? error : { error: String(error) })
      return null
    }
  }

  /** Download and decrypt a non-image media item from WeChat CDN. */
  async downloadFile(
    file: NonNullable<IncomingMessage['_fileItems']>[number]
  ): Promise<{ data: Buffer; filename: string; mediaType: string } | null> {
    try {
      const data = await cdnDownloadFile(file.item)
      if (!data) return null
      return { data, filename: file.filename, mediaType: file.mediaType }
    } catch (error) {
      this.logger.error('Failed to download WeChat file', error instanceof Error ? error : { error: String(error) })
      return null
    }
  }

  /** Send an image to a user by uploading it to the WeChat CDN. */
  async sendImage(userId: string, imageData: Buffer): Promise<void> {
    const contextToken = this.contextTokenFor(userId)
    const uploaded = await this.uploadMedia(userId, imageData, UploadMediaType.IMAGE)
    await this.sendMediaMessage(
      userId,
      {
        type: MessageItemType.IMAGE,
        image_item: { media: this.toCdnMedia(uploaded), mid_size: uploaded.ciphertextSize }
      },
      contextToken
    )
  }

  /** Send a video as video media and every other non-image type as a file attachment. */
  async sendFile(userId: string, filename: string, data: Buffer, mediaType: string): Promise<void> {
    if (mediaType.startsWith('image/')) {
      await this.sendImage(userId, data)
      return
    }

    const contextToken = this.contextTokenFor(userId)
    if (mediaType.startsWith('video/')) {
      const uploaded = await this.uploadMedia(userId, data, UploadMediaType.VIDEO)
      await this.sendMediaMessage(
        userId,
        {
          type: MessageItemType.VIDEO,
          video_item: { media: this.toCdnMedia(uploaded), video_size: uploaded.ciphertextSize }
        },
        contextToken
      )
      return
    }

    const uploaded = await this.uploadMedia(userId, data, UploadMediaType.FILE)
    await this.sendMediaMessage(
      userId,
      {
        type: MessageItemType.FILE,
        file_item: { media: this.toCdnMedia(uploaded), file_name: filename, len: String(data.length) }
      },
      contextToken
    )
  }

  async run(): Promise<void> {
    if (this.runPromise) return this.runPromise

    this.stopped = false
    this.runPromise = this.runLoop()

    try {
      await this.runPromise
    } finally {
      this.runPromise = null
      this.currentPollController = null
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.currentPollController?.abort()
    this.stopController.abort()
    await this.notifyStop()
  }

  private async runLoop(): Promise<void> {
    const credentials = await this.ensureCredentials()
    try {
      await apiNotifyLifecycle(this.baseUrl, credentials.token, this.uin, 'start')
    } catch (error) {
      this.logger.warn('Failed to notify WeChat that the bot started', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.logger.info('Long-poll loop started')
    let retryDelayMs = 1_000

    while (!this.stopped) {
      try {
        const credentials = await this.ensureCredentials()
        this.currentPollController = new AbortController()
        const updates = await getUpdates(
          this.baseUrl,
          credentials.token,
          this.uin,
          this.cursor,
          this.currentPollController.signal
        )

        this.currentPollController = null
        this.cursor = updates.get_updates_buf || this.cursor
        retryDelayMs = 1_000
        if (this.stopped) break
        this.onConnected?.()

        for (const raw of updates.msgs ?? []) {
          this.rememberContext(raw)
          const incoming = this.toIncomingMessage(raw)
          if (incoming) {
            await this.dispatchMessage(incoming)
          }
        }
      } catch (error) {
        this.currentPollController = null

        if (this.stopped && isAbortError(error)) break

        if (isSessionExpired(error)) {
          throw new Error('WeChat login expired. Scan a new QR code in channel settings.')
        }
        this.reportError(error)
        await delay(retryDelayMs, undefined, { signal: this.stopController.signal }).catch(() => {})
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000)
      }
    }

    this.logger.info('Long-poll loop stopped')
  }

  private async ensureCredentials(): Promise<Credentials> { return this.credentials }

  private async sendText(userId: string, text: string, contextToken: string): Promise<void> {
    if (text.length === 0) {
      throw new Error('Message text cannot be empty.')
    }

    const credentials = await this.ensureCredentials()
    await apiSendMessage(this.baseUrl, credentials.token, this.uin, buildTextMessage(userId, contextToken, text))
  }

  private contextTokenFor(userId: string): string {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      this.logger.warn('No cached context token for media, sending without context', { userId })
    }
    return contextToken ?? ''
  }

  private async uploadMedia(
    userId: string,
    data: Buffer,
    mediaType: UploadMediaType
  ): Promise<{ downloadEncryptedQueryParam: string; aeskey: Buffer; ciphertextSize: number }> {
    const credentials = await this.ensureCredentials()
    const uploaded = await cdnUploadMedia(this.baseUrl, credentials.token, this.uin, userId, data, mediaType)
    if (!uploaded) throw new Error('Failed to upload media to WeChat CDN')
    return uploaded
  }

  private toCdnMedia(uploaded: { downloadEncryptedQueryParam: string; aeskey: Buffer }): CDNMedia {
    return {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aeskey.toString('hex')).toString('base64'),
      encrypt_type: 1
    }
  }

  private async sendMediaMessage(userId: string, item: MessageItem, contextToken: string): Promise<void> {
    const credentials = await this.ensureCredentials()
    await apiSendMessage(this.baseUrl, credentials.token, this.uin, {
      from_user_id: '',
      to_user_id: userId,
      client_id: randomUUID(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: [item]
    })
  }

  private async notifyStop(): Promise<void> {
    const credentials = this.credentials
    if (!credentials) return
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl)

    try {
      await apiNotifyLifecycle(this.baseUrl, credentials.token, this.uin, 'stop')
    } catch (error) {
      this.logger.warn('Failed to notify WeChat that the bot stopped', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async dispatchMessage(message: IncomingMessage): Promise<void> {
    if (this.handlers.length === 0) return

    const results = await Promise.allSettled(this.handlers.map(async (handler) => handler(message)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.reportError(result.reason)
      }
    }
  }

  private rememberContext(message: WeixinMessage): void {
    const userId = message.message_type === MessageType.USER ? message.from_user_id : message.to_user_id
    if (userId && message.context_token) {
      // Evict oldest entry when map exceeds max size
      if (this.contextTokens.size >= MAX_CONTEXT_TOKENS && !this.contextTokens.has(userId)) {
        const oldest = this.contextTokens.keys().next().value
        if (oldest !== undefined) this.contextTokens.delete(oldest)
      }
      this.contextTokens.set(userId, message.context_token)
    }
  }

  private toIncomingMessage(message: WeixinMessage): IncomingMessage | null {
    if (message.message_type !== MessageType.USER) return null

    const hasCdnMedia = (media?: CDNMedia) => Boolean(media?.encrypt_query_param || media?.full_url)
    const imageItems = message.item_list
      .filter((item) => item.type === MessageItemType.IMAGE && hasCdnMedia(item.image_item?.media))
      .map((item) => item.image_item!)

    const fileItems = message.item_list.flatMap((item) => {
      if (item.type === MessageItemType.FILE && item.file_item && hasCdnMedia(item.file_item.media)) {
        return [
          { filename: item.file_item.file_name ?? 'file', mediaType: 'application/octet-stream', item: item.file_item }
        ]
      }
      if (item.type === MessageItemType.VIDEO && item.video_item && hasCdnMedia(item.video_item.media)) {
        return [{ filename: `video-${message.message_id}.mp4`, mediaType: 'video/mp4', item: item.video_item }]
      }
      if (item.type === MessageItemType.VOICE && item.voice_item && hasCdnMedia(item.voice_item.media)) {
        return [
          {
            filename: `voice-${message.message_id}.${voiceExtension(item.voice_item)}`,
            mediaType: voiceMediaType(item.voice_item),
            item: item.voice_item
          }
        ]
      }
      return []
    })

    return {
      messageId: String(message.message_id),
      userId: message.from_user_id,
      text: extractText(message.item_list),
      type: detectType(message.item_list),
      _contextToken: message.context_token,
      timestamp: new Date(message.create_time_ms),
      _imageItems: imageItems.length > 0 ? imageItems : undefined,
      _fileItems: fileItems.length > 0 ? fileItems : undefined
    }
  }

  private reportError(error: unknown): void {
    this.logger.error('Bot error', error instanceof Error ? error : { error: String(error) })
    this.onErrorCallback?.(error)
  }
}

// --------------- Helpers ---------------

function detectType(items: MessageItem[]): IncomingMessage['type'] {
  const first = items[0]
  switch (first?.type) {
    case MessageItemType.IMAGE:
      return 'image'
    case MessageItemType.VOICE:
      return 'voice'
    case MessageItemType.FILE:
      return 'file'
    case MessageItemType.VIDEO:
      return 'video'
    default:
      return 'text'
  }
}

function extractText(items: MessageItem[]): string {
  return items.map(extractItemText).filter(Boolean).join('\n')
}

function extractItemText(item: MessageItem): string {
  let text: string
  switch (item.type) {
    case MessageItemType.TEXT:
      text = item.text_item?.text ?? ''
      break
    case MessageItemType.IMAGE:
    case MessageItemType.FILE:
      text = ''
      break
    case MessageItemType.VOICE:
      text = item.voice_item?.text ?? '[voice]'
      break
    case MessageItemType.VIDEO:
      text = '[video]'
      break
    default:
      text = ''
  }

  const quoted = item.ref_msg
    ? [item.ref_msg.title, item.ref_msg.message_item && extractItemText(item.ref_msg.message_item)]
    : []
  const quote = quoted.filter((value): value is string => Boolean(value)).join(' | ')
  return quote ? `[quote: ${quote}]${text ? `\n${text}` : ''}` : text
}

function voiceExtension(item: VoiceItem): string {
  switch (item.encode_type) {
    case 7:
      return 'mp3'
    case 8:
      return 'ogg'
    default:
      return 'silk'
  }
}

function voiceMediaType(item: VoiceItem): string {
  switch (item.encode_type) {
    case 7:
      return 'audio/mpeg'
    case 8:
      return 'audio/ogg'
    default:
      return 'audio/silk'
  }
}

function detectImageMime(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif'
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp'
  return 'image/jpeg'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === -14
}
