'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChevronDown, Cpu, FileText, FileUp, LibraryBig, Plus, RefreshCw, Search, Settings2, Trash2, Users } from 'lucide-react';
import {
  ModelPicker,
  type ModelProviderOption,
} from '@/components/dashboard/models/ModelPicker';
import { NativeSelect } from '@/components/ui/NativeSelect';

type KnowledgeBase = {
  id: string;
  name: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  threshold: number;
  providerId: string | null;
  providerName: string | null;
  agentIds: string[];
  documents: Array<{ id: string; filename: string; status: string; error: string | null }>;
};

type KnowledgeTab = 'documents' | 'recall' | 'access' | 'settings';

function statusClass(status: string) {
  if (status === 'indexed') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'failed') return 'bg-red-500/10 text-red-700 dark:text-red-300';
  return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

export function WorkspaceKnowledge({
  slug,
  initialBases,
  providers,
  sandboxes,
  agents,
}: {
  slug: string;
  initialBases: KnowledgeBase[];
  providers: ModelProviderOption[];
  sandboxes: Array<{ id: string; name: string; running: boolean }>;
  agents: Array<{ id: string; name: string }>;
}) {
  const t = useTranslations('console.knowledge');
  const tabs: Array<{ id: KnowledgeTab; label: string; icon: typeof FileText }> = [
    { id: 'documents', label: t('documents'), icon: FileText },
    { id: 'recall', label: t('recallTest'), icon: Search },
    { id: 'access', label: t('agentAccess'), icon: Users },
    { id: 'settings', label: t('settings'), icon: Settings2 },
  ];
  const statusLabels: Record<string, string> = {
    pending: t('statusPending'), indexing: t('statusIndexing'), indexed: t('statusIndexed'), failed: t('statusFailed'),
  };
  const [bases, setBases] = useState(initialBases);
  const [selectedId, setSelectedId] = useState(initialBases[0]?.id ?? '');
  const [creatingBase, setCreatingBase] = useState(initialBases.length === 0);
  const [activeTab, setActiveTab] = useState<KnowledgeTab>('documents');
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [model, setModel] = useState(providers[0]?.models[0] ?? 'text-embedding-3-small');
  const [chunkSize, setChunkSize] = useState(1200);
  const [chunkOverlap, setChunkOverlap] = useState(200);
  const [topK, setTopK] = useState(6);
  const [threshold, setThreshold] = useState(0.2);
  const [sandboxId, setSandboxId] = useState(sandboxes.find((item) => item.running)?.id ?? sandboxes[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [agentIds, setAgentIds] = useState<string[]>(initialBases[0]?.agentIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recallQuery, setRecallQuery] = useState('');
  const [recallResults, setRecallResults] = useState<Array<{ chunkId: string; filename: string; sourcePath: string; content: string; score: number }>>([]);
  const selected = bases.find((base) => base.id === selectedId) ?? null;
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null;

  function selectBase(base: KnowledgeBase) {
    setSelectedId(base.id);
    setCreatingBase(false);
    setActiveTab('documents');
    setAgentIds(base.agentIds);
    setName(base.name);
    setProviderId(base.providerId ?? '');
    setModel(base.embeddingModel);
    setChunkSize(base.chunkSize);
    setChunkOverlap(base.chunkOverlap);
    setTopK(base.topK);
    setThreshold(base.threshold);
    setRecallResults([]);
    setError(null);
  }

  function beginCreate() {
    setCreatingBase(true);
    setName('');
    setProviderId(providers[0]?.id ?? '');
    setModel(providers[0]?.models[0] ?? 'text-embedding-3-small');
    setChunkSize(1200);
    setChunkOverlap(200);
    setTopK(6);
    setThreshold(0.2);
    setError(null);
  }

  async function saveAgentBindings(next: string[]) {
    if (!selected) return;
    setAgentIds(next); setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/knowledge/${selected.id}/agents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: next }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || t('accessError'));
      setBases((current) => current.map((base) => base.id === selected.id ? { ...base, agentIds: next } : base));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('accessError')); }
    finally { setBusy(false); }
  }

  async function createBase() {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/v1/knowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: slug, name, providerId, embeddingModel: model, chunkSize, chunkOverlap, topK, threshold }) });
      const base = await response.json() as { id?: string; error?: string };
      if (!response.ok || !base.id) throw new Error(base.error || t('createError'));
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('createError')); setBusy(false); }
  }

  async function saveSettings() {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/knowledge/${selected.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, providerId, embeddingModel: model, chunkSize, chunkOverlap, topK, threshold }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || t('settingsError'));
      setBases((current) => current.map((base) => base.id === selected.id ? {
        ...base,
        name,
        providerId,
        providerName: selectedProvider?.name ?? null,
        embeddingModel: model,
        chunkSize,
        chunkOverlap,
        topK,
        threshold,
      } : base));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('settingsError')); }
    finally { setBusy(false); }
  }

  async function deleteBase() {
    if (!selected || !window.confirm(t('deleteConfirm', { name: selected.name }))) return;
    const response = await fetch(`/api/v1/knowledge/${selected.id}`, { method: 'DELETE' });
    if (response.ok) window.location.reload();
  }

  async function upload() {
    if (!selected || !file || !sandboxId) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData(); form.set('file', file); form.set('sandboxId', sandboxId);
      const response = await fetch(`/api/v1/knowledge/${selected.id}/documents`, { method: 'POST', body: form });
      const document = await response.json() as { id?: string; filename?: string; status?: string; error?: string | null };
      if (!response.ok || !document.id || !document.filename || !document.status) throw new Error(document.error || t('importError'));
      setBases((current) => current.map((base) => base.id === selected.id ? { ...base, documents: [{ id: document.id!, filename: document.filename!, status: document.status!, error: document.error ?? null }, ...base.documents] } : base));
      setFile(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('importError')); }
    finally { setBusy(false); }
  }

  async function reindexDocument(documentId: string) {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/knowledge/${selected.id}/documents/${documentId}`, { method: 'POST' });
      const document = await response.json() as { id?: string; status?: string; error?: string | null };
      if (!response.ok || !document.id || !document.status) throw new Error(document.error || t('reindexError'));
      setBases((current) => current.map((base) => base.id === selected.id ? { ...base, documents: base.documents.map((item) => item.id === document.id ? { ...item, status: document.status!, error: document.error ?? null } : item) } : base));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('reindexError')); }
    finally { setBusy(false); }
  }

  async function deleteDocument(documentId: string) {
    if (!selected) return;
    const response = await fetch(`/api/v1/knowledge/${selected.id}/documents/${documentId}`, { method: 'DELETE' });
    if (response.ok) setBases((current) => current.map((base) => base.id === selected.id ? { ...base, documents: base.documents.filter((item) => item.id !== documentId) } : base));
  }

  async function testRecall() {
    if (!selected || !recallQuery.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/knowledge/${selected.id}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: recallQuery }) });
      const body = await response.json() as { sources?: typeof recallResults; error?: string };
      if (!response.ok) throw new Error(body.error || t('recallError'));
      setRecallResults(body.sources ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('recallError')); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="flex max-h-56 min-h-0 flex-col bg-card lg:max-h-none">
        <div className="flex h-14 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><LibraryBig className="size-4 text-muted-foreground" />{t('title')}</div>
          <button type="button" onClick={beginCreate} aria-label={t('newBase')} title={t('newBase')} className="ui-button-ghost ui-icon-button"><Plus className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {bases.length ? <ul className="space-y-1">{bases.map((base) => (
            <li key={base.id}><button type="button" onClick={() => selectBase(base)} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${base.id === selectedId && !creatingBase ? 'bg-muted' : 'hover:bg-muted/60'}`}><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground"><LibraryBig className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{base.name}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{t('documentCount', { count: base.documents.length })}</span></span></button></li>
          ))}</ul> : <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('noBases')}</p>}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto">
        {creatingBase ? (
          <div className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-8 sm:py-10">
            <div className="pb-5"><h1 className="text-lg font-semibold">{t('newBase')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('newBaseDescription')}</p></div>
            {!providers.length ? <div className="py-6 text-sm"><p className="font-medium">{t('providerRequired')}</p><p className="mt-1 text-muted-foreground">{t('providerRequiredDescription')}</p><Link href={`/app/${encodeURIComponent(slug)}/providers`} className="ui-button-secondary mt-4 inline-flex">{t('openProviderSettings')}</Link></div> : (
              <div className="grid gap-x-5 gap-y-4 py-6 sm:grid-cols-2">
                <label className="sm:col-span-2 text-xs font-medium text-muted-foreground">{t('name')}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('namePlaceholder')} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label>
                <div className="sm:col-span-2 text-xs font-medium text-muted-foreground">
                  <span>{t('embeddingModel')}</span>
                  <ModelPicker
                    providers={providers}
                    value={providerId && model ? { providerId, model } : null}
                    onSelect={(selection) => {
                      setProviderId(selection.providerId);
                      setModel(selection.model);
                    }}
                    onConfigure={() => {
                      window.location.assign(`/app/${encodeURIComponent(slug)}/providers`);
                    }}
                    trigger={(
                      <button type="button" aria-label={`${t('embeddingModel')}: ${model || t('embeddingModel')}`} className="ui-input mt-1.5 flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-foreground">
                        <Cpu className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{model || t('embeddingModel')}</span>
                        <span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    )}
                  />
                </div>
                <label className="text-xs font-medium text-muted-foreground">{t('chunkSize')}<input type="number" min={200} max={8000} value={chunkSize} onChange={(event) => setChunkSize(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label>
                <label className="text-xs font-medium text-muted-foreground">{t('chunkOverlap')}<input type="number" min={0} value={chunkOverlap} onChange={(event) => setChunkOverlap(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label>
                <label className="text-xs font-medium text-muted-foreground">{t('resultsPerSearch')}<input type="number" min={1} max={20} value={topK} onChange={(event) => setTopK(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label>
                <label className="text-xs font-medium text-muted-foreground">{t('similarityThreshold')}<input type="number" min={-1} max={1} step={0.05} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label>
              </div>
            )}
            {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
            {providers.length ? <div className="flex justify-end gap-2 pt-4"><button type="button" onClick={() => selected ? setCreatingBase(false) : undefined} disabled={!selected} className="ui-button-secondary">{t('cancel')}</button><button type="button" onClick={createBase} disabled={busy || !name.trim() || !providerId || !model.trim()} className="ui-button-primary"><Plus className="size-4" />{busy ? t('creating') : t('createBase')}</button></div> : null}
          </div>
        ) : selected ? (
          <div className="flex min-h-full flex-col">
            <header className="shrink-0 px-5 py-4 sm:px-7">
              <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h1 className="truncate text-lg font-semibold">{selected.name}</h1><p className="mt-1 truncate text-xs text-muted-foreground">{selected.providerName ?? t('providerUnavailable')} <span aria-hidden="true">·</span> {selected.embeddingModel} <span aria-hidden="true">·</span> {t('documentCount', { count: selected.documents.length })}</p></div><button type="button" onClick={() => void deleteBase()} aria-label={t('deleteBase')} title={t('deleteBase')} className="ui-button-ghost ui-icon-button shrink-0 text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button></div>
              <nav aria-label={t('viewsLabel')} className="mt-4 flex gap-1 overflow-x-auto">{tabs.map((tab) => { const Icon = tab.icon; return <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${activeTab === tab.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}><Icon className="size-3.5" />{tab.label}</button>; })}</nav>
            </header>
            {error ? <p role="alert" className="mx-5 mt-4 border-l-2 border-destructive pl-3 text-sm text-destructive sm:mx-7">{error}</p> : null}

            {activeTab === 'documents' ? <div className="p-5 sm:p-7">
              <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-end">
                <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{t('sourceSandbox')}<NativeSelect value={sandboxId} onChange={(event) => setSandboxId(event.target.value)} className="ui-input h-10 w-full text-foreground" wrapperClassName="mt-1.5">{sandboxes.map((sandbox) => <option key={sandbox.id} value={sandbox.id} disabled={!sandbox.running}>{sandbox.name}{sandbox.running ? '' : ` (${t('stopped')})`}</option>)}</NativeSelect></label>
                <label className="ui-button-secondary h-10 cursor-pointer"><FileUp className="size-4" /><span className="max-w-48 truncate">{file?.name ?? t('chooseFile')}</span><input type="file" accept=".txt,.md,.mdx,.csv,.json,text/plain,text/markdown,text/csv,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="sr-only" /></label>
                <button type="button" onClick={upload} disabled={busy || !file || !sandboxId} className="ui-button-primary h-10"><FileUp className="size-4" />{busy ? t('importing') : t('import')}</button>
              </div>
              {selected.documents.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-sm"><thead className="border-b border-border text-[11px] font-medium uppercase text-muted-foreground"><tr><th className="pb-2 font-medium">{t('document')}</th><th className="w-32 pb-2 font-medium">{t('status')}</th><th className="w-20 pb-2 text-right font-medium">{t('actions')}</th></tr></thead><tbody className="divide-y divide-border">{selected.documents.map((document) => <tr key={document.id}><td className="py-3"><div className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{document.filename}</span></div>{document.error ? <p className="mt-1 pl-6 text-xs text-destructive">{document.error}</p> : null}</td><td className="py-3"><span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-medium ${statusClass(document.status)}`}>{statusLabels[document.status] ?? document.status}</span></td><td className="py-3"><div className="flex justify-end"><button type="button" onClick={() => void reindexDocument(document.id)} disabled={busy} aria-label={t('reindexDocument')} title={t('reindexDocument')} className="ui-button-ghost ui-icon-button"><RefreshCw className="size-3.5" /></button><button type="button" onClick={() => void deleteDocument(document.id)} disabled={busy} aria-label={t('deleteDocument')} title={t('deleteDocument')} className="ui-button-ghost ui-icon-button text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button></div></td></tr>)}</tbody></table></div> : <div className="py-16 text-center"><FileText className="mx-auto size-6 text-muted-foreground" /><h2 className="mt-3 text-sm font-semibold">{t('noDocuments')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('noDocumentsDescription')}</p></div>}
            </div> : null}

            {activeTab === 'recall' ? <div className="mx-auto w-full max-w-4xl p-5 sm:p-7"><div className="flex gap-2 pb-5"><input value={recallQuery} onChange={(event) => setRecallQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void testRecall(); }} placeholder={t('recallPlaceholder')} className="ui-input h-10 min-w-0 flex-1" /><button type="button" onClick={testRecall} disabled={busy || !recallQuery.trim()} className="ui-button-primary h-10"><Search className="size-4" />{t('search')}</button></div>{recallResults.length ? <ol className="divide-y divide-border">{recallResults.map((result, index) => <li key={result.chunkId} className="py-5"><div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate text-sm font-medium">{index + 1}. {result.filename}</p><span className="shrink-0 font-mono text-xs text-muted-foreground">{result.score.toFixed(3)}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/90">{result.content}</p><code className="mt-2 block truncate text-[11px] text-muted-foreground">{result.sourcePath}</code></li>)}</ol> : <div className="py-16 text-center"><Search className="mx-auto size-6 text-muted-foreground" /><h2 className="mt-3 text-sm font-semibold">{t('recallEmptyTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('recallEmptyDescription')}</p></div>}</div> : null}

            {activeTab === 'access' ? <div className="mx-auto w-full max-w-3xl p-5 sm:p-7"><div className="pb-4"><h2 className="text-sm font-semibold">{t('agentAccess')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('agentAccessDescription')}</p></div><div className="divide-y divide-border">{agents.map((agent) => { const checked = agentIds.includes(agent.id); return <label key={agent.id} className="flex cursor-pointer items-center justify-between gap-4 py-3.5 text-sm"><span>{agent.name}</span><input type="checkbox" checked={checked} onChange={() => void saveAgentBindings(checked ? agentIds.filter((id) => id !== agent.id) : [...agentIds, agent.id])} disabled={busy} className="size-4" /></label>; })}</div></div> : null}

            {activeTab === 'settings' ? <div className="mx-auto w-full max-w-3xl p-5 sm:p-7"><div className="grid gap-x-5 gap-y-4 sm:grid-cols-2"><label className="sm:col-span-2 text-xs font-medium text-muted-foreground">{t('name')}<input value={name} onChange={(event) => setName(event.target.value)} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label><div className="sm:col-span-2 text-xs font-medium text-muted-foreground"><span>{t('embeddingModel')}</span><ModelPicker providers={providers} value={providerId && model ? { providerId, model } : null} onSelect={(selection) => { setProviderId(selection.providerId); setModel(selection.model); }} onConfigure={() => { const returnTo = `/app/${encodeURIComponent(slug)}/knowledge`; window.location.assign(`/app/${encodeURIComponent(slug)}/providers?returnTo=${encodeURIComponent(returnTo)}`); }} trigger={<button type="button" aria-label={`${t('embeddingModel')}: ${model || t('embeddingModel')}`} className="ui-input mt-1.5 flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-foreground"><Cpu className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{model || t('embeddingModel')}</span><span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></button>} /></div><label className="text-xs font-medium text-muted-foreground">{t('chunkSize')}<input type="number" min={200} max={8000} value={chunkSize} onChange={(event) => setChunkSize(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label><label className="text-xs font-medium text-muted-foreground">{t('chunkOverlap')}<input type="number" min={0} value={chunkOverlap} onChange={(event) => setChunkOverlap(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label><label className="text-xs font-medium text-muted-foreground">{t('resultsPerSearch')}<input type="number" min={1} max={20} value={topK} onChange={(event) => setTopK(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label><label className="text-xs font-medium text-muted-foreground">{t('similarityThreshold')}<input type="number" min={-1} max={1} step={0.05} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} className="ui-input mt-1.5 h-10 w-full text-foreground" /></label></div><div className="mt-6 flex justify-end pt-4"><button type="button" onClick={saveSettings} disabled={busy || !name.trim() || !providerId || !model.trim()} className="ui-button-primary">{busy ? t('saving') : t('saveSettings')}</button></div></div> : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}
