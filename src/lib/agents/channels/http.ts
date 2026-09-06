const PLATFORM_DOMAINS = [
  'telegram.org', 'qq.com', 'weixin.qq.com', 'qpic.cn', 'gtimg.cn', 'qqbot.cn',
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net',
  'slack.com', 'slack-edge.com', 'slack-files.com', 'slack-msgs.com',
  'feishu.cn', 'larksuite.com', 'feishucdn.com',
];
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export function sanitizeRemoteUrl(raw: string, websocket = false): string {
  const url = new URL(raw);
  if (url.protocol !== (websocket ? 'wss:' : 'https:') || url.username || url.password || url.port
    || !PLATFORM_DOMAINS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('Channel URL must use a trusted platform host over TLS.');
  }
  return url.toString();
}

export async function channelFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = sanitizeRemoteUrl(String(input));
  const headers = new Headers(init.headers);
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await globalThis.fetch(url, { ...init, headers, signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      const next = sanitizeRemoteUrl(new URL(response.headers.get('location')!, url).toString());
      if (new URL(url).origin !== new URL(next).origin) {
        if (init.body) throw new Error('Cross-origin channel redirects cannot forward request bodies.');
        headers.delete('authorization');
      }
      url = next;
      continue;
    }
    if (Number(response.headers.get('content-length')) > MAX_FILE_SIZE_BYTES) {
      await response.body?.cancel();
      throw new Error('Channel response exceeds the file size limit.');
    }
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_FILE_SIZE_BYTES) throw new Error('Channel response exceeds the file size limit.');
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  throw new Error('Channel request has too many redirects.');
}
