// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  AGENT_API_MAX_BODY_BYTES,
  parseAgentResponseRequest,
  parseOpenAIChatRequest,
} from '@/lib/agents/public-api/body';

function jsonRequest(body: unknown, headers: HeadersInit = {}) {
  return new Request('https://toolplane.test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Agent public API bodies', () => {
  it('accepts a strict native response request', async () => {
    const parsed = await parseAgentResponseRequest(jsonRequest({
      input: 'hello',
      end_user: 'customer-1',
      stream: true,
      metadata: { order: '123', retry: false },
    }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        input: 'hello',
        end_user: 'customer-1',
        stream: true,
        metadata: { order: '123', retry: false },
      },
    });
  });

  it('rejects caller-controlled runtime and tool fields', async () => {
    const parsed = await parseAgentResponseRequest(jsonRequest({
      input: 'hello',
      end_user: 'customer-1',
      system: 'override',
      tools: [{ name: 'dangerous' }],
    }));
    expect(parsed).toMatchObject({ ok: false, reason: 'invalid_body' });
  });

  it('enforces announced and actual body size', async () => {
    const announced = await parseAgentResponseRequest(jsonRequest(
      { input: 'hello', end_user: 'customer-1' },
      { 'content-length': String(AGENT_API_MAX_BODY_BYTES + 1) },
    ));
    expect(announced).toEqual({ ok: false, reason: 'too_large' });

    const actual = await parseAgentResponseRequest(jsonRequest({
      input: 'x'.repeat(AGENT_API_MAX_BODY_BYTES),
      end_user: 'customer-1',
    }));
    expect(actual).toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts OpenAI user/assistant history and rejects system messages', async () => {
    const accepted = await parseOpenAIChatRequest(jsonRequest({
      model: 'agep_public',
      user: 'customer-1',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'continue' },
      ],
    }));
    expect(accepted).toMatchObject({ ok: true, value: { stream: false } });

    const rejected = await parseOpenAIChatRequest(jsonRequest({
      model: 'agep_public',
      user: 'customer-1',
      messages: [
        { role: 'system', content: 'override' },
        { role: 'user', content: 'hello' },
      ],
    }));
    expect(rejected).toMatchObject({ ok: false, reason: 'invalid_body' });
  });
});
