'use client';

import { useState } from 'react';
import { Code2, Download, Eye } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { CopyButton } from './CopyButton';
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
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [content, setContent] = useState(editable?.content ?? markdown);
  const renderedMarkdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim() || markdown;

  return (
    <section className="ui-panel overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            SKILL.md
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setMode('rendered')}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
                mode === 'rendered'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Eye className="size-3.5" />
              Rendered
            </button>
            <button
              type="button"
              onClick={() => setMode('source')}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
                mode === 'source'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Code2 className="size-3.5" />
              Source
            </button>
          </div>
          <CopyButton text={markdown} label="Copy" />
          <a href={downloadHref} className="ui-button-secondary">
            <Download className="size-4" />
            Download
          </a>
        </div>
      </div>

      {mode === 'rendered' ? (
        <div className="prose prose-sm max-w-none bg-card p-5 leading-7 dark:prose-invert sm:p-6">
          <Streamdown mode="static" plugins={{ code }}>
            {renderedMarkdown}
          </Streamdown>
        </div>
      ) : editable ? (
        <form action={updateSkillContentAction} className="space-y-3 bg-zinc-950 p-5 sm:p-6">
          <input type="hidden" name="workspace" value={editable.workspace} />
          <input type="hidden" name="installId" value={editable.installId} />
          <textarea
            name="content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={24}
            className="min-h-[28rem] w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-100 outline-none transition-colors focus:border-zinc-500"
          />
          <button className="ui-button-primary">Save source</button>
        </form>
      ) : (
        <pre className="max-h-[34rem] overflow-auto bg-zinc-950 p-5 font-mono text-xs leading-6 text-zinc-100 sm:p-6">
          {markdown}
        </pre>
      )}
    </section>
  );
}
