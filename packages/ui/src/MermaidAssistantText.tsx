'use client';

import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins } from 'streamdown';

const plugins = { code, mermaid };
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

export default function MermaidAssistantText() {
  return (
    <StreamdownTextPrimitive
      plugins={plugins}
      remarkPlugins={remarkPlugins}
      mermaid={{ config: { securityLevel: 'strict' } }}
      linkSafety={{ enabled: true }}
      security={{
        allowedProtocols: ['http', 'https', 'mailto'],
        allowDataImages: false,
      }}
      className="space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}
