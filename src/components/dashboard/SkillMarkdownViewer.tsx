'use client';
import { Button, ButtonLink } from '@/components/motion/button';


import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Code2, Download, Eye } from 'lucide-react';
import { code } from '@streamdown/code';
import { CopyButton } from './CopyButton';
import { SafeStreamdown } from './SafeStreamdown';
import { updateSkillContentAction } from '@/lib/skills/actions';

export function SkillMarkdownViewer({
  markdown,
  downloadHref,
  editable,
}: {
  markdown: string;
  downloadHref: string;
  editable?: {
    workspace: string;
    installId: string;
    content: string;
  };
}) {
  const t = useTranslations('console.skills');
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [content, setContent] = useState(editable?.content ?? markdown);
  const renderedMarkdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim() || markdown;

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            SKILL.md
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            <Button type="button" onClick={() => setMode('rendered')} variant={mode === "rendered" ? "primary" : "ghost"} size="sm"><Eye className="size-3.5" />
            {t('rendered')}</Button>
            <Button type="button" onClick={() => setMode('source')} variant={mode === "source" ? "primary" : "ghost"} size="sm"><Code2 className="size-3.5" />
            {t('source')}</Button>
          </div>
          <CopyButton text={markdown} label={t('copy')} />
          <ButtonLink href={downloadHref} variant="secondary" size="md">
            <Download className="size-4" />
            {t('download')}
          </ButtonLink>
        </div>
      </div>

      {mode === 'rendered' ? (
        <div className="prose prose-sm max-w-none bg-card p-5 leading-7 dark:prose-invert sm:p-6">
          <SafeStreamdown
            mode="static"
            plugins={{ code }}
            components={{
              h1: ({ children }) => <h3>{children}</h3>,
            }}
          >
            {renderedMarkdown}
          </SafeStreamdown>
        </div>
      ) : editable ? (
        <form action={updateSkillContentAction} className="space-y-3 bg-background p-5 sm:p-6">
          <input type="hidden" name="workspace" value={editable.workspace} />
          <input type="hidden" name="installId" value={editable.installId} />
          <textarea name="content" value={content} onChange={(event) => setContent(event.target.value)} rows={24} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[28rem]" />
          <Button variant="primary" size="md" type="submit">{t('saveSource')}</Button>
        </form>
      ) : (
        <pre className="max-h-[34rem] overflow-auto bg-background p-5 font-mono text-xs leading-6 text-foreground sm:p-6">
          {markdown}
        </pre>
      )}
    </section>
  );
}
