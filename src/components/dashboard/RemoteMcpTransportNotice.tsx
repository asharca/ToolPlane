'use client';

import { useLocale } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { isInsecureRemoteMcpUrl } from '@/lib/remote-mcp/url';

const messages = {
  en: {
    help: 'Remote MCP supports HTTPS (recommended) and HTTP, including explicit ports. Endpoint URLs cannot contain credentials, query parameters or fragments.',
    title: 'Unencrypted HTTP connection',
    risk: 'Traffic between ToolPlane and this MCP server has no TLS encryption or server identity verification. Bearer tokens, authentication headers, tool arguments and returned data may be intercepted or modified; stolen credentials may be reused.',
    guidance: 'Prefer HTTPS. Use HTTP only on a trusted, isolated network or through an encrypted tunnel covering the entire connection. An internal network is not automatically safe. Avoid sending production credentials or sensitive data.',
    boundary: 'HTTPS on the ToolPlane website does not protect this upstream HTTP connection. Private destinations still require administrator approval; HTTP does not bypass SSRF protections.',
  },
  zh: {
    help: '远程 MCP 支持 HTTPS（推荐）和 HTTP，也支持显式端口。地址不能包含用户名、密码、查询参数或片段。',
    title: 'HTTP 明文连接（不安全）',
    risk: 'ToolPlane 与此 MCP 服务之间的流量没有 TLS 加密或服务器身份校验。Bearer Token、认证请求头、工具参数及返回数据可能被窃听或篡改，泄露的凭据可能被盗用。',
    guidance: '优先使用 HTTPS。仅在可信、隔离的网络或覆盖完整连接的加密隧道中使用 HTTP；内网不等于安全。避免传输生产凭据和敏感数据。',
    boundary: '即使 ToolPlane 网页使用 HTTPS，也不会保护这一段 HTTP 连接。私有地址仍需管理员允许；HTTP 不会绕过 SSRF 防护。',
  },
} as const;

export function RemoteMcpTransportNotice({
  url,
  showHelp = false,
}: {
  url: string | null | undefined;
  showHelp?: boolean;
}) {
  const locale = useLocale();
  const text = locale.toLowerCase().startsWith('zh') ? messages.zh : messages.en;
  const insecure = isInsecureRemoteMcpUrl(url ?? '');

  if (!insecure && !showHelp) return null;

  return (
    <div className="space-y-2" data-testid="remote-mcp-transport-notice">
      {showHelp ? <p className="text-xs leading-5 text-muted-foreground">{text.help}</p> : null}
      {insecure ? (
        <div role="alert" className="flex gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-2">
            <p className="font-semibold">{text.title}</p>
            <p>{text.risk}</p>
            <p>{text.guidance}</p>
            <p>{text.boundary}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
