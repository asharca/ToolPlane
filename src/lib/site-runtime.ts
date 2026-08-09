import 'server-only';
import { runtimeEnv } from '@/lib/runtime-env';
import { SITE } from '@/lib/site';

export function runtimeSupportEmail(): string {
  return runtimeEnv('NEXT_PUBLIC_SUPPORT_EMAIL')?.trim() || SITE.supportEmail;
}
