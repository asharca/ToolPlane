// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrokerToken: vi.fn(),
  ensureBroker: vi.fn(),
  publicUrl: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/agents/hermes/dashboard-broker', () => ({
  ensureHermesDashboardBroker: mocks.ensureBroker,
  hermesDashboardBrokerPublicUrl: mocks.publicUrl,
}));
vi.mock('@/lib/agents/hermes/token', () => ({
  createHermesDashboardBrokerAccessToken: mocks.createBrokerToken,
  verifyHermesDashboardAccessToken: mocks.verifyToken,
}));

import { GET } from '@/app/api/v1/agent-runtimes/[runtimeId]/dashboard/[accessToken]/[[...path]]/route';

const params = Promise.resolve({
  runtimeId: 'runtime-1',
  accessToken: 'page-token',
  path: ['assets', 'app.js'],
});

describe('Hermes dashboard redirect boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyToken.mockReturnValue(true);
    mocks.ensureBroker.mockResolvedValue({ bind: '0.0.0.0', port: 9332 });
    mocks.createBrokerToken.mockReturnValue('broker-token');
    mocks.publicUrl.mockReturnValue(
      'http://toolplane.test:9332/agent-runtimes/runtime-1/dashboard/broker-token/assets/app.js',
    );
  });

  it('rejects an invalid page capability before starting the broker', async () => {
    mocks.verifyToken.mockReturnValue(false);

    const response = await GET(new Request('http://toolplane.test/dashboard'), { params });

    expect(response.status).toBe(401);
    expect(mocks.ensureBroker).not.toHaveBeenCalled();
  });

  it('redirects the iframe to a parent-bound capability on a separate origin', async () => {
    const request = new Request('http://toolplane.test/dashboard?theme=dark', {
      headers: {
        authorization: 'Bearer toolplane-secret',
        cookie: 'mcp_session=secret',
      },
    });

    const response = await GET(request, { params });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://toolplane.test:9332/agent-runtimes/runtime-1/dashboard/broker-token/assets/app.js',
    );
    expect(mocks.createBrokerToken).toHaveBeenCalledWith(
      'runtime-1',
      'http://toolplane.test',
    );
    expect(mocks.publicUrl).toHaveBeenCalledWith(
      request.url,
      'runtime-1',
      'broker-token',
      ['assets', 'app.js'],
      9332,
    );
  });

  it('binds the broker token to the browser-facing forwarded origin', async () => {
    const request = new Request('http://app:3000/dashboard', {
      headers: {
        host: 'app:3000',
        'x-forwarded-host': 'tp.example.com',
        'x-forwarded-proto': 'https',
      },
    });

    await GET(request, { params });

    expect(mocks.createBrokerToken).toHaveBeenCalledWith(
      'runtime-1',
      'https://tp.example.com',
    );
    expect(mocks.publicUrl).toHaveBeenCalledWith(
      'https://tp.example.com/dashboard',
      'runtime-1',
      'broker-token',
      ['assets', 'app.js'],
      9332,
    );
  });

  it('returns an actionable error when no separate public origin is available', async () => {
    mocks.publicUrl.mockImplementation(() => {
      throw new Error('Hermes dashboard public URL must use a different origin from ToolPlane.');
    });

    const response = await GET(new Request('http://toolplane.test/dashboard'), { params });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Hermes dashboard public URL must use a different origin from ToolPlane.',
    });
  });
});
