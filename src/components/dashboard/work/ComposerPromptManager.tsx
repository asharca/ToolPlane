'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/Dialog';

type Prompt = { id: string; title: string; content: string };

export function ComposerPromptManager({ agentId, onClose, onInsert }: {
  agentId: string; onClose: () => void; onInsert: (text: string) => void;
}) {
  const t = useTranslations('console.workComposer');
  const common = useTranslations('common');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Partial<Prompt> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/api/v1/agents/${encodeURIComponent(agentId)}/composer-prompts`;
  const loadFailed = t('loadFailed');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(loadFailed);
      const data = await response.json();
      if (!controller.signal.aborted) setPrompts(data.prompts);
    }).catch(() => { if (!controller.signal.aborted) setError(loadFailed); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, loadFailed]);

  async function mutate(body: Record<string, unknown>) {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(t('saveFailed'));
      const listed = await fetch(endpoint, { cache: 'no-store' });
      if (!listed.ok) throw new Error(t('loadFailed'));
      setPrompts((await listed.json()).prompts);
      setEditing(null);
      setDeleting(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('saveFailed')); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogPortal><DialogOverlay /><DialogContent aria-describedby={undefined} className="!flex !max-h-[calc(100dvh-2rem)] !max-w-2xl !flex-col !gap-3 !rounded-lg">
      <header className="flex items-center justify-between gap-3">
        <DialogTitle className="!text-base !tracking-normal">{t('prompts')}</DialogTitle>
        <DialogClose asChild><button type="button" disabled={saving} aria-label={common('close')} title={common('close')} className="ui-button-ghost ui-icon-button"><X className="size-4" /></button></DialogClose>
      </header>
      {editing ? <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'save', ...editing }); }} className="min-h-0 space-y-3 overflow-y-auto">
        <label className="block text-xs font-medium">{t('promptTitle')}<input autoFocus required disabled={saving} maxLength={120} className="ui-input mt-1 w-full" value={editing.title ?? ''} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
        <label className="block text-xs font-medium">{t('promptContent')}<textarea aria-label={t('promptContent')} required disabled={saving} maxLength={20_000} rows={8} className="ui-input mt-1 max-h-72 min-h-32 w-full resize-y" value={editing.content ?? ''} onChange={(event) => setEditing({ ...editing, content: event.target.value })} /></label>
        <div className="flex justify-end gap-2"><button type="button" disabled={saving} className="ui-button-secondary" onClick={() => setEditing(null)}>{common('cancel')}</button><button type="submit" disabled={saving} className="ui-button-primary">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{common('save')}</button></div>
      </form> : <>
        <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('searchPrompts')} placeholder={t('searchPrompts')} className="ui-input h-9 w-full pl-9" /></div><button type="button" aria-label={t('addPrompt')} title={t('addPrompt')} className="ui-button-secondary ui-icon-button" onClick={() => setEditing({ title: '', content: '' })}><Plus className="size-4" /></button></div>
        <div className="min-h-32 overflow-y-auto">
          {loading ? <Loader2 className="mx-auto my-10 size-5 animate-spin" aria-label={common('loading')} /> : prompts.filter((prompt) => `${prompt.title} ${prompt.content}`.toLowerCase().includes(query.toLowerCase())).map((prompt) => <div key={prompt.id} className="flex items-center gap-1 border-b border-border py-2 last:border-0">
            <button type="button" className="min-w-0 flex-1 rounded-md px-2 py-1 text-left hover:bg-muted" onClick={() => { onInsert(prompt.content); onClose(); }}><span className="block truncate text-sm font-medium">{prompt.title}</span><span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{prompt.content}</span></button>
            <button type="button" aria-label={t('editPrompt', { title: prompt.title })} title={t('editPrompt', { title: prompt.title })} className="ui-button-ghost ui-icon-button" onClick={() => setEditing({ id: prompt.id, title: prompt.title, content: prompt.content })}><Pencil className="size-4" /></button>
            {deleting === prompt.id ? <><button type="button" disabled={saving} aria-label={t('confirmDelete')} title={t('confirmDelete')} className="ui-button-ghost ui-icon-button text-destructive" onClick={() => void mutate({ action: 'delete', id: prompt.id })}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}</button><button type="button" disabled={saving} aria-label={common('cancel')} className="ui-button-ghost ui-icon-button" onClick={() => setDeleting(null)}><X className="size-4" /></button></> : <button type="button" aria-label={t('deletePrompt', { title: prompt.title })} title={t('deletePrompt', { title: prompt.title })} className="ui-button-ghost ui-icon-button" onClick={() => setDeleting(prompt.id)}><Trash2 className="size-4" /></button>}
          </div>)}
          {!loading && !prompts.length ? <p className="py-10 text-center text-sm text-muted-foreground">{t('noPrompts')}</p> : null}
        </div>
      </>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </DialogContent></DialogPortal>
  </Dialog>;
}
