import { describe, expect, it } from 'vitest';
import { hasMermaidFence } from '../../packages/ui/src/chat-markdown';

describe('hasMermaidFence', () => {
  it.each([
    '```mermaid\ngraph TD\n```',
    '> ``` mermaid title="Flow"\n> graph TD\n> ```',
    '1. Flow\n\n   ~~~mermaid\n   graph TD\n   ~~~',
  ])('detects a Mermaid fence: %s', (markdown) => {
    expect(hasMermaidFence(markdown)).toBe(true);
  });

  it('does not load Mermaid for prose or other code fences', () => {
    expect(hasMermaidFence('Mermaid is mentioned here.\n\n```ts\nconst mermaid = true;\n```')).toBe(false);
  });
});
