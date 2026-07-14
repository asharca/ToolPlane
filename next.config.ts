import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
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
