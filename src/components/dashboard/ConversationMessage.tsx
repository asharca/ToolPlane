'use client';

import { lazy, Suspense, useMemo } from 'react';
import type { CustomRendererProps, CustomRenderer } from 'streamdown';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import { StreamingResponse } from '@/components/agents/streaming-response';
import { CodeBlock } from '@/components/agents/code-block';
import type { AgentCodeLanguage } from '@/components/agents/agent-code';

const MermaidAssistantMarkdown = lazy(() => import('./MermaidAssistantMarkdown'));
const codeLanguages: Record<string, AgentCodeLanguage> = { bash: 'bash', sh: 'bash', diff: 'diff', json: 'json', text: 'text', txt: 'text', plaintext: 'text', tsx: 'tsx', ts: 'typescript', typescript: 'typescript' };

function AssistantCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  return <CodeBlock code={code} language={codeLanguages[language] ?? 'text'} status={isIncomplete ? 'streaming' : 'complete'} />;
}

/** Route every actual code-fence language to beUI without changing its contents. */
export function assistantCodeRenderers(text: string): CustomRenderer[] {
  const languages = new Set(['', 'text', 'plaintext']);
  for (const match of text.matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gm)) {
    if (match[1].toLowerCase() !== 'mermaid') languages.add(match[1]);
  }
  return [{ language: [...languages], component: AssistantCodeBlock }];
}

export function AssistantMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const renderers = useMemo(() => assistantCodeRenderers(text), [text]);
  const markdown = <SafeStreamdown assistant mode={streaming ? 'streaming' : 'static'} parseIncompleteMarkdown={streaming} isAnimating={streaming} plugins={{ renderers }} preserveSoftBreaks linkSafety={{ enabled: true }}>{text}</SafeStreamdown>;
  return <StreamingResponse status={streaming ? 'streaming' : 'complete'} showActions={false}>
    {/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b/im.test(text) ? <Suspense fallback={markdown}><MermaidAssistantMarkdown text={text} streaming={streaming} /></Suspense> : markdown}
  </StreamingResponse>;
}
