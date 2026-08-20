import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import robots from '@/app/robots';

describe('public HTTP baseline', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    vi.unstubAllEnvs();
  });

  it('keeps global framing blocked while allowing workspace tabs to frame themselves', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(2);
    const globalRule = rules?.find((rule) => rule.source === '/:path*');
    const workspaceRule = rules?.find((rule) => rule.source === '/app/:workspace/:path+');
    const globalHeaders = Object.fromEntries(
      (globalRule?.headers ?? []).map(({ key, value }) => [key, value]),
    );
    const workspaceHeaders = Object.fromEntries(
      (workspaceRule?.headers ?? []).map(({ key, value }) => [key, value]),
    );

    expect(globalHeaders['Content-Security-Policy']).toContain("default-src 'self'");
    expect(globalHeaders['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(globalHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(globalHeaders['Strict-Transport-Security']).toBeUndefined();
    expect(globalHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(globalHeaders['X-Frame-Options']).toBe('DENY');
    expect(globalHeaders['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(globalHeaders['Permissions-Policy']).toContain('camera=()');
    expect(workspaceHeaders['Content-Security-Policy']).toContain("frame-ancestors 'self'");
    expect(workspaceHeaders['X-Frame-Options']).toBe('SAMEORIGIN');
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
