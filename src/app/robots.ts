import type { MetadataRoute } from 'next';
import { siteOrigin } from './(site)/_lib/metadata';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/admin$',
        '/admin/',
        '/api$',
        '/api/',
        '/app$',
        '/app/',
        '/news$',
        '/news/',
      ],
    },
    sitemap: new URL('/sitemap.xml', origin).toString(),
    host: origin.origin,
  };
}
