// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBaseFromRequest, installBaseFromHeaders } from '@/lib/plugin/service-base';
import { isSameOriginRequest } from '@/lib/http/origin';
afterEach(() => vi.unstubAllEnvs());
describe('trusted installation service identity', () => {
  it('preserves the configured deployment path without trusting forwarded hosts or changing CSRF origin checks', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/instance-a/');
    const headers = new Headers({ 'host': 'spoofed.example', 'x-forwarded-host': 'spoofed.example', origin: 'https://app.example' });
    const req = new Request('http://internal:3000/install/id', { headers });
    expect(installBaseFromRequest(req)).toBe('https://app.example/instance-a');
    expect(installBaseFromHeaders(headers)).toBe('https://app.example/instance-a');
    expect(isSameOriginRequest(req)).toBe(true);
  });
  it('rejects embedded URL credentials and preserves the existing local port development escape hatch', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://user:secret@app.example/base');
    expect(() => installBaseFromRequest(new Request('https://app.example/install/id'))).toThrow('Invalid public');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000/base');
    expect(installBaseFromRequest(new Request('http://localhost:3002/install/id'))).toBe('http://localhost:3002');
  });
});
