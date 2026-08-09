import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveLocale } from '@/i18n/locale';
import { proxy } from '@/proxy';

describe('resolveLocale', () => {
  it('prefers a supported locale cookie across devices', () => {
    expect(resolveLocale('zh', 'en-US,en;q=0.9')).toBe('zh');
  });

  it('falls back to the first supported Accept-Language entry', () => {
    expect(resolveLocale(undefined, 'fr-FR, zh-CN;q=0.9, en;q=0.8')).toBe('zh');
    expect(resolveLocale('invalid', 'en-GB, zh;q=0.8')).toBe('en');
  });

  it('honors quality weights and ignores explicitly rejected locales', () => {
    expect(resolveLocale(undefined, 'en-US;q=0.2, zh-CN;q=0.9')).toBe('zh');
    expect(resolveLocale(undefined, 'zh;q=0, en;q=0.5')).toBe('en');
  });

  it('uses English when the request has no supported preference', () => {
    expect(resolveLocale(undefined, 'fr-FR')).toBe('en');
  });
});

describe('locale and transport proxy', () => {
  it('sets cache variation and HSTS only when the request arrived over HTTPS', () => {
    const secure = proxy(new NextRequest('http://toolplane.internal/app/login', {
      headers: {
        'accept-language': 'zh-CN, en;q=0.8',
        'x-forwarded-proto': 'https',
      },
    }));
    expect(secure.headers.get('content-language')).toBe('zh');
    expect(secure.headers.get('vary')).toBe('Accept-Language, Cookie');
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');

    const localHttp = proxy(new NextRequest('http://localhost:10030/app/login'));
    expect(localHttp.headers.get('strict-transport-security')).toBeNull();
  });
});
