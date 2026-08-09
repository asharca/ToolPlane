import type { Locale } from './routing';

const SUPPORTED_LOCALES = new Set<Locale>(['en', 'zh']);

export function resolveLocale(
  cookieLocale: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (cookieLocale && SUPPORTED_LOCALES.has(cookieLocale as Locale)) {
    return cookieLocale as Locale;
  }

  const preferences = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [rawTag, ...parameters] = part.split(';');
      const qualityParameter = parameters
        .map((parameter) => parameter.trim().match(/^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/i))
        .find(Boolean);
      const quality = qualityParameter ? Number(qualityParameter[1]) : 1;
      return { tag: rawTag?.trim().toLowerCase(), quality, index };
    })
    .filter(({ quality }) => Number.isFinite(quality) && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { tag } of preferences) {
    if (tag?.startsWith('zh')) return 'zh';
    if (tag?.startsWith('en')) return 'en';
  }
  return 'en';
}
