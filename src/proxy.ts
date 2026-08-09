import { NextResponse, type NextRequest } from 'next/server';
import { resolveLocale } from '@/i18n/locale';

export function proxy(request: NextRequest) {
  const locale = resolveLocale(
    request.cookies.get('NEXT_LOCALE')?.value,
    request.headers.get('accept-language'),
  );
  const response = NextResponse.next();
  response.headers.set('Content-Language', locale);
  response.headers.set('Vary', 'Accept-Language, Cookie');
  const forwardedProtocol = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProtocol === 'https' || request.nextUrl.protocol === 'https:') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$|icon\\.svg$|opengraph-image(?:/|$)|robots\\.txt$|sitemap\\.xml$).*)',
  ],
};
