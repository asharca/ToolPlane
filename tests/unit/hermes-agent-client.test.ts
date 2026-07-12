import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { uiMessagesToHermes } from '@/lib/agents/hermes/client';

describe('Hermes chat projection', () => {
  it('preserves text and maps inline images to OpenAI image parts', () => {
    const messages: UIMessage[] = [{
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
      ],
    }];

    expect(uiMessagesToHermes(messages)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]);
  });

  it('renders unsupported files as explicit attachment context', () => {
    const messages: UIMessage[] = [{
      id: 'm1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'application/pdf', filename: 'report.pdf', url: 'https://files.test/report.pdf' }],
    }];
    expect(uiMessagesToHermes(messages)[0].content).toContain('report.pdf');
  });

  it('never forwards system messages from ToolPlane to Hermes', () => {
    const messages = [{
      id: 'system-1',
      role: 'system',
      parts: [{ type: 'text', text: 'ToolPlane override' }],
    }] as unknown as UIMessage[];

    expect(uiMessagesToHermes(messages)).toEqual([]);
  });
});
