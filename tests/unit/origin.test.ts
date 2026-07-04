import { afterEach, describe, expect, it } from 'vitest';
import { originFromHeaders, originFromRequest } from '@/lib/http/origin';

describe('request origin helpers', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it('prefers the configured public app URL over request host headers', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://mcp.example.com';
    const headers = new Headers({
      host: 'attacker.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });

    expect(originFromHeaders(headers)).toBe('https://mcp.example.com');
  });

  it('allows local request ports to override a local configured origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const req = new Request('http://localhost:3002/install/x', {
      headers: { host: 'localhost:3002' },
    });

    expect(originFromRequest(req)).toBe('http://localhost:3002');
  });

  it('falls back to forwarded host when no app URL is configured', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const headers = new Headers({
      host: 'localhost:3000',
      'x-forwarded-host': 'mcp.internal',
      'x-forwarded-proto': 'https',
    });

    expect(originFromHeaders(headers)).toBe('https://mcp.internal');
  });
});
