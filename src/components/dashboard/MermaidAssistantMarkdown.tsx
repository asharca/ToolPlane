'use client';

import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';

export default function MermaidAssistantMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className: string;
}) {
  return (
    <SafeStreamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      plugins={{ code, mermaid }}
      mermaid={{ config: { securityLevel: 'strict' } }}
      preserveSoftBreaks
      linkSafety={{ enabled: true }}
      className={className}
    >
      {text}
    </SafeStreamdown>
  );
}
