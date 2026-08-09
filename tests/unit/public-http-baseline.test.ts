import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import robots from '@/app/robots';

describe('public HTTP baseline', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    vi.unstubAllEnvs();
  });

  it('applies the production security headers to every route', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.source).toBe('/:path*');
    const headers = Object.fromEntries(
      (rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
    );

    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('does not pin HSTS or require HTTPS in local development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const rules = await nextConfig.headers?.();
    const headers = Object.fromEntries(
      (rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
    );

    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(headers['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['Content-Security-Policy']).toContain("'unsafe-eval'");
  });

  it('keeps the production Docker image usable on an HTTP origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const rules = await nextConfig.headers?.();
    const headers = Object.fromEntries(
      (rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
    );

    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(headers['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['Content-Security-Policy']).not.toContain("'unsafe-eval'");
  });

  it('advertises the canonical sitemap and keeps private surfaces out of crawlers', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://tp.example.com';
    const result = robots();
    expect(result.sitemap).toBe('https://tp.example.com/sitemap.xml');
    expect(result.host).toBe('https://tp.example.com');
    expect(result.rules).toMatchObject({
      userAgent: '*',
      allow: '/',
      disallow: expect.arrayContaining(['/admin/', '/api/', '/app/', '/news/']),
    });
  });
});
