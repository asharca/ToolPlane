'use client';

import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { updateSkillContentAction, updateSkillAttributesAction, publishSkillAction, deleteCustomSkillAction } from '@/lib/skills/actions';

type Props = {
  slug: string;
  installId: string;
  status: string;
  content: string;
  description: string;
  userInvocable: boolean;
  agentInvocable: boolean;
  effort: string;
};

const input = 'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

export function SkillEditor(p: Props) {
  const [content, setContent] = useState(p.content);
  const [view, setView] = useState<'source' | 'rendered'>('source');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <form action={publishSkillAction}>
          <input type="hidden" name="workspace" value={p.slug} />
          <input type="hidden" name="installId" value={p.installId} />
          <button className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            {p.status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
        </form>
        <span className="rounded-md border border-zinc-200 px-2 py-1 text-xs capitalize text-zinc-500 dark:border-zinc-700">{p.status}</span>
        <form action={deleteCustomSkillAction} className="ml-auto">
          <input type="hidden" name="workspace" value={p.slug} />
          <input type="hidden" name="installId" value={p.installId} />
          <button className="h-8 rounded-md border border-zinc-200 px-3 text-xs text-zinc-500 hover:border-red-200 hover:text-red-600 dark:border-zinc-700">Delete</button>
        </form>
      </div>

      <form action={updateSkillAttributesAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <input type="hidden" name="workspace" value={p.slug} />
        <input type="hidden" name="installId" value={p.installId} />
        <label className="flex flex-col gap-1 text-xs text-zinc-500">Description<input name="description" defaultValue={p.description} className={`${input} w-64`} /></label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><input type="checkbox" name="userInvocable" defaultChecked={p.userInvocable} /> User-invocable</label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><input type="checkbox" name="agentInvocable" defaultChecked={p.agentInvocable} /> Agent-invocable</label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">Effort
          <select name="effort" defaultValue={p.effort} className={input}><option value="default">default</option><option value="low">low</option><option value="high">high</option></select>
        </label>
        <button className="h-8 rounded-md border border-zinc-200 px-3 text-xs font-medium dark:border-zinc-700">Save attributes</button>
      </form>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">SKILL.md</h2>
          <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
            <button type="button" onClick={() => setView('source')} className={`rounded px-2 py-1 ${view === 'source' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : ''}`}>Source</button>
            <button type="button" onClick={() => setView('rendered')} className={`rounded px-2 py-1 ${view === 'rendered' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : ''}`}>Rendered</button>
          </div>
        </div>
        {view === 'source' ? (
          <form action={updateSkillContentAction} className="space-y-2">
            <input type="hidden" name="workspace" value={p.slug} />
            <input type="hidden" name="installId" value={p.installId} />
            <textarea name="content" value={content} onChange={(e) => setContent(e.target.value)} rows={20} className="w-full rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900" />
            <button className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Save</button>
          </form>
        ) : (
          <div className="prose prose-sm max-w-none rounded-md border border-zinc-200 p-4 dark:prose-invert dark:border-zinc-700">
            <Streamdown>{content}</Streamdown>
          </div>
        )}
      </div>
    </div>
  );
}
