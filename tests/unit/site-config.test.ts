import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE, mailto } from '@/lib/site';
import { runtimeSupportEmail } from '@/lib/site-runtime';

afterEach(() => vi.unstubAllEnvs());

describe('public site configuration', () => {
  it('uses deployable contact addresses instead of local placeholders', () => {
    expect(SITE.supportEmail).toContain('@');
    expect(SITE.supportEmail).not.toContain('.local');
    expect(SITE.feedbackEmail).not.toContain('.local');
    expect(mailto(SITE.supportEmail)).toBe(`mailto:${SITE.supportEmail}`);
  });

  it('reads the support address from the runtime environment', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'runtime-support@example.com');
    expect(runtimeSupportEmail()).toBe('runtime-support@example.com');
  });
});
