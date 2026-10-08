// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Https from 'node:https';
import type * as Dns from 'node:dns/promises';

const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), status: 200, body: Buffer.from('{}') }));
vi.mock('node:dns/promises', async original => ({ ...await original<typeof Dns>(), lookup: transport.lookup }));
vi.mock('node:https', async original => ({ ...await original<typeof Https>(), request: transport.request }));
vi.mock('@/lib/market/skills', () => ({ MarketError: class extends Error { constructor(readonly code: string, message: string) { super(message); } } }));
import { piSourceRequest, piSourceUrl, sourceAuthorization } from '@/lib/market/pi-package-network';

beforeEach(() => {
  vi.clearAllMocks(); transport.status = 200; transport.body = Buffer.from('{}');
  transport.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  transport.request.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    Object.assign(request, {
      destroy: (error?: Error) => { if (error) request.emit('error', error); request.emit('close'); },
      end: () => queueMicrotask(() => {
        const response = new PassThrough(); Object.assign(response, { statusCode: transport.status });
        callback(response); if (!response.destroyed) response.end(transport.body); request.emit('close');
      }),
    });
    return request;
  });
});
const authentication = { url: 'https://registry.example/private/', authorization: 'Bearer write-secret' };
describe('source network credential boundary', () => {
  it.each(['https://registry.example/private-evil/pkg', 'https://other.example/private/pkg', 'https://registry.example/public/pkg'])('never attaches scoped credentials to %s', async target => {
    expect(sourceAuthorization(new URL(target), authentication)).toBeUndefined();
    await piSourceRequest(new URL(target), { authentication });
    expect(transport.request.mock.calls[0][1].headers.authorization).toBeUndefined();
  });
  it('authenticates only the configured target and pins the checked DNS address', async () => {
    await expect(piSourceRequest(new URL('https://registry.example/private/pkg'), { authentication })).resolves.toEqual(Buffer.from('{}'));
    const options = transport.request.mock.calls[0][1]; expect(options.headers.authorization).toBe('Bearer write-secret');
    const callback = vi.fn(); options.lookup('registry.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
  it('rejects redirects instead of forwarding a token or publication body', async () => {
    transport.status = 307;
    await expect(piSourceRequest(new URL('https://registry.example/private/pkg'), { authentication, method: 'PUT', body: Buffer.from('artifact') })).rejects.toMatchObject({ code: 'source_redirect_blocked' });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }],
  ].map(addresses => ({ addresses })))('blocks private and mixed DNS before opening HTTP %#', async ({ addresses }) => {
    transport.lookup.mockResolvedValue(addresses);
    await expect(piSourceRequest(new URL('https://registry.example/private/pkg'), { authentication })).rejects.toMatchObject({ code: 'source_network_blocked' });
    expect(transport.request).not.toHaveBeenCalled();
  });
  it.each(['https://user:secret@example.com/a', 'http://example.com/a', 'https://example.com/a?token=secret', 'https://example.com/a/%252e%252e/b', 'https://example.com/a/%2e%2e%2fb'])('rejects unsafe source %s', value => {
    expect(() => piSourceUrl(value)).toThrow();
  });
  it('bounds bytes actually received rather than Content-Length', async () => {
    transport.body = Buffer.alloc(20);
    await expect(piSourceRequest(new URL('https://registry.example/private/pkg'), { maxBytes: 10 })).rejects.toMatchObject({ code: 'source_response_too_large' });
  });
  it('sanitizes credential rejection without returning the upstream body', async () => {
    transport.status = 401; transport.body = Buffer.from('Bearer write-secret stacktrace');
    await expect(piSourceRequest(new URL('https://registry.example/private/pkg'), { authentication })).rejects.toMatchObject({ code: 'source_auth_failed', message: 'The package source request could not be completed safely.' });
  });
});
