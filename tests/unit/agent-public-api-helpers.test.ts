// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { allowedCorsOrigin, normalizedOrigin } from '@/lib/agents/public-api/cors';
import { AgentApiError, errorResponse } from '@/lib/agents/public-api/errors';
import { encodeSseDone, encodeSseEvent } from '@/lib/agents/public-api/sse';
import {
  isPinnedPublicHermesImage,
  isPublicHermesImage,
} from '@/lib/agents/hermes/constants';

describe('Agent public API helpers', () => {
  it('normalizes exact HTTP origins and denies paths or credentials', () => {
    expect(normalizedOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(normalizedOrigin('https://app.example.com/path')).toBeNull();
    expect(normalizedOrigin('https://user:pass@app.example.com')).toBeNull();
    expect(allowedCorsOrigin('https://app.example.com', ['https://app.example.com'])).toBe(
      'https://app.example.com',
    );
    expect(allowedCorsOrigin('https://evil.example', ['https://app.example.com'])).toBeNull();
  });

  it('encodes named SSE events and the terminal marker', () => {
    const decoder = new TextDecoder();
    expect(decoder.decode(encodeSseEvent('response.created', { id: 'resp_1' }, 1))).toBe(
      'id: 1\nevent: response.created\ndata: {"id":"resp_1"}\n\n',
    );
    expect(decoder.decode(encodeSseDone())).toBe('data: [DONE]\n\n');
  });

  it('uses a stable public error envelope and retry header', async () => {
    const response = errorResponse(
      new AgentApiError('rate_limit_exceeded', 'Slow down.', 429, 12),
      'req_123',
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    await expect(response.json()).resolves.toEqual({
      error: {
        message: 'Slow down.',
        type: 'invalid_request_error',
        code: 'rate_limit_exceeded',
        request_id: 'req_123',
      },
    });
  });

  it('accepts reviewed release tags only for publication and immutable digests for execution', () => {
    const digest = `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`;
    expect(isPublicHermesImage('nousresearch/hermes-agent:v2026.8.3')).toBe(true);
    expect(isPublicHermesImage('nousresearch/hermes-agent:latest')).toBe(false);
    expect(isPinnedPublicHermesImage('nousresearch/hermes-agent:v2026.8.3')).toBe(false);
    expect(isPinnedPublicHermesImage(digest)).toBe(true);
  });
});
