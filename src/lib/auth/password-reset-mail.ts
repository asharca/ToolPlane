import 'server-only';
import nodemailer from 'nodemailer';
import { runtimeEnv } from '@/lib/runtime-env';

function publicAppOrigin(): string {
  const raw = runtimeEnv('NEXT_PUBLIC_APP_URL')?.trim();
  if (!raw) throw new Error('NEXT_PUBLIC_APP_URL is required to send password-reset emails');

  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_APP_URL must use http or https');
  }
  return url.origin;
}

export function passwordResetEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim() && process.env.SMTP_FROM?.trim());
}

export function passwordResetUrl(token: string): string {
  const url = new URL('/app/reset-password', publicAppOrigin());
  url.searchParams.set('token', token);
  return url.toString();
}

export async function sendPasswordResetEmail(input: {
  to: string;
  token: string;
  locale?: string | null;
}): Promise<void> {
  const smtpUrl = process.env.SMTP_URL?.trim();
  const from = process.env.SMTP_FROM?.trim();
  if (!smtpUrl || !from) throw new Error('Password-reset email is not configured');

  const url = passwordResetUrl(input.token);
  const zh = input.locale?.toLowerCase().startsWith('zh');
  const subject = zh ? '重置您的 ToolPlane 密码' : 'Reset your ToolPlane password';
  const text = zh
    ? `有人请求重置您的 ToolPlane 密码。请在 1 小时内打开以下链接：\n\n${url}\n\n如果这不是您本人操作，请忽略此邮件。`
    : `Someone requested a password reset for your ToolPlane account. Open this link within 1 hour:\n\n${url}\n\nIf this was not you, you can ignore this email.`;

  const transport = nodemailer.createTransport(smtpUrl);
  await transport.sendMail({ from, to: input.to, subject, text });
}
