import { runtimeEnv } from '@/lib/runtime-env';

export function secureSessionCookie(
  appUrl = runtimeEnv('NEXT_PUBLIC_APP_URL'),
  environment = process.env.NODE_ENV,
): boolean {
  if (appUrl) {
    try {
      const protocol = new URL(appUrl).protocol;
      if (protocol === 'https:') return true;
      if (protocol === 'http:') return false;
    } catch {
      // Fall through to the secure production default for malformed values.
    }
  }
  return environment === 'production';
}
