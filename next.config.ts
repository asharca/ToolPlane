import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

function securityHeaders(environment = process.env.NODE_ENV, allowSameOriginFrames = false) {
  const isProduction = environment === 'production';
  const scriptPolicy = isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const connectPolicy = "connect-src 'self' http: https: ws: wss:";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${allowSameOriginFrames ? "'self'" : "'none'"}`,
    "object-src 'none'",
    scriptPolicy,
    connectPolicy,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob: https:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');

  return [
    {
      key: 'Content-Security-Policy',
      value: contentSecurityPolicy,
    },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: allowSameOriginFrames ? 'SAMEORIGIN' : 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    },
  ];
}

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders() },
      {
        source: '/app/:workspace/:path+',
        headers: securityHeaders(process.env.NODE_ENV, true),
      },
    ];
  },
  outputFileTracingIncludes: {
    '/*': [
      'node_modules/node-pty/**/*',
      'node_modules/ws/**/*',
    ],
  },
  outputFileTracingExcludes: {
    '/*': [
      'src/**/*',
      'tests/**/*',
      'docs/**/*',
      'e2e/**/*',
      'scraper/**/*',
      'infra/**/*',
      'runtime/**/*',
      'scripts/**/*',
      'packages/**/*',
      'prisma/**/*',
      'public/**/*',
      '*.md',
      '*.json',
      '*.mjs',
      '*.ts',
      '*.yml',
      'Dockerfile',
      'pnpm-lock.yaml',
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '64mb',
    },
  },
};

export default withNextIntl(nextConfig);
