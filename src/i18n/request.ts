import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import enMessages from '../../messages/en.json';
import zhMessages from '../../messages/zh.json';
import type { Locale } from './routing';
import { resolveLocale } from './locale';

const MESSAGES = {
  en: enMessages,
  zh: zhMessages,
} as const;

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const locale: Locale = resolveLocale(
    cookieStore.get('NEXT_LOCALE')?.value,
    headerStore.get('accept-language'),
  );

  return {
    locale,
    messages: MESSAGES[locale],
  };
});
