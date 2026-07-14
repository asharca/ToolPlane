import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import enMessages from '../../messages/en.json';
import zhMessages from '../../messages/zh.json';
import type { Locale } from './routing';

const LOCALES: Locale[] = ['en', 'zh'];
const MESSAGES = {
  en: enMessages,
  zh: zhMessages,
} as const;

function pickLocaleFromAcceptLanguage(acceptLang: string): Locale {
  for (const part of acceptLang.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const cookie = cookieStore.get('NEXT_LOCALE')?.value;
  let locale: Locale = 'en';

  if (cookie && (LOCALES as string[]).includes(cookie)) {
    locale = cookie as Locale;
  } else {
    locale = pickLocaleFromAcceptLanguage(
      headerStore.get('accept-language') ?? '',
    );
  }

  return {
    locale,
    messages: MESSAGES[locale],
  };
});
