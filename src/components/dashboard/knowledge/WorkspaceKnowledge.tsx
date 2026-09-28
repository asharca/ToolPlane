'use client';

import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { FormCheckbox } from '@/components/ui/FormCheckbox';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { AISidebar } from '@/components/agents/ai-sidebar';
import { AnimatedSidebarHeader, AnimatedSidebarContent } from '@/components/motion/animated-sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { DashboardTable } from '@/components/dashboard/DashboardTable';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ChevronDown, Cpu, FileText, FileUp, LibraryBig, Plus, RefreshCw, Search, Settings2, Trash2, Users } from 'lucide-react';
import {
  ModelPicker,
  type ModelProviderOption,
} from '@/components/dashboard/models/ModelPicker';
import { FormSelect } from '@/components/ui/FormSelect';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--workspace-surface,var(--background))] lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
      <aside aria-label={t('title')} className="flex max-h-56 min-h-0 flex-col lg:max-h-none">
        <AnimatedSidebarHeader className="h-14 flex-row items-center justify-between px-3 py-0">
          <div className="flex items-center gap-2 text-sm font-semibold"><LibraryBig className="size-4 text-muted-foreground" />{t('title')}</div>
          <Button type="button" onClick={beginCreate} aria-label={t('newBase')} title={t('newBase')} variant={"ghost"} size={"icon"}><Plus className="size-4" /></Button>
        </AnimatedSidebarHeader>
        <AnimatedSidebarContent>
          {bases.length ? <AISidebar ariaLabel={t('title')} items={bases.map((base) => ({ id: base.id, label: base.name, kind: 'project' as const }))} activeId={creatingBase ? null : selectedId} renderIcon={(item) => <LibraryBig className="size-4" aria-label={t('documentCount', { count: bases.find((base) => base.id === item.id)?.documents.length ?? 0 })} />} onActiveChange={(id) => { const base = bases.find((item) => item.id === id); if (base) selectBase(base); }} /> : <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('noBases')}</p>}
        </AnimatedSidebarContent>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto">
        {creatingBase ? (
          <div className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-8 sm:py-10">
            <div className="pb-5"><h1 className="text-lg font-semibold">{t('newBase')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('newBaseDescription')}</p></div>
            {!providers.length ? <div className="py-6 text-sm"><p className="font-medium">{t('providerRequired')}</p><p className="mt-1 text-muted-foreground">{t('providerRequiredDescription')}</p><ButtonLink href={`/app/${encodeURIComponent(slug)}/providers`} variant="secondary" className="mt-4">{t('openProviderSettings')}</ButtonLink></div> : (
              <div className="grid gap-x-5 gap-y-4 py-6 sm:grid-cols-2">
                <div className="sm:col-span-2 text-xs font-medium text-muted-foreground">{t('name')}<Input placeholder={t('namePlaceholder')} value={String(name)} label={t('name')} onChange={(value) => setName(value)} className="mt-1.5 w-full" /></div>
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
                      <Button type="button" aria-label={`${t('embeddingModel')}: ${model || t('embeddingModel')}`} variant={"outline"} size={"sm"} className="mt-1.5 flex w-full items-center gap-2 text-left"><Cpu className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{model || t('embeddingModel')}</span>
                      <span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></Button>
                    )}
                  />
                </div>
                <div className="text-xs font-medium text-muted-foreground">{t('chunkSize')}<Input min={200} max={8000} type={"number"} value={String(chunkSize)} label={t('chunkSize')} onChange={(value) => setChunkSize(Number(value))} className="mt-1.5 w-full" /></div>
                <div className="text-xs font-medium text-muted-foreground">{t('chunkOverlap')}<Input min={0} type={"number"} value={String(chunkOverlap)} label={t('chunkOverlap')} onChange={(value) => setChunkOverlap(Number(value))} className="mt-1.5 w-full" /></div>
                <div className="text-xs font-medium text-muted-foreground">{t('resultsPerSearch')}<Input min={1} max={20} type={"number"} value={String(topK)} label={t('resultsPerSearch')} onChange={(value) => setTopK(Number(value))} className="mt-1.5 w-full" /></div>
                <div className="text-xs font-medium text-muted-foreground">{t('similarityThreshold')}<Input min={-1} max={1} step={0.05} type={"number"} value={String(threshold)} label={t('similarityThreshold')} onChange={(value) => setThreshold(Number(value))} className="mt-1.5 w-full" /></div>
              </div>
            )}
            {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
            {providers.length ? <div className="flex justify-end gap-2 pt-4"><Button type="button" onClick={() => selected ? setCreatingBase(false) : undefined} disabled={!selected} variant={"secondary"} size={"sm"}>{t('cancel')}</Button><Button type="button" onClick={createBase} disabled={busy || !name.trim() || !providerId || !model.trim()} variant={"primary"} size={"sm"}><Plus className="size-4" />{busy ? t('creating') : t('createBase')}</Button></div> : null}
          </div>
        ) : selected ? (
          <div className="flex min-h-full flex-col">
            <header className="shrink-0 px-5 py-4 sm:px-7">
              <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h1 className="truncate text-lg font-semibold">{selected.name}</h1><p className="mt-1 truncate text-xs text-muted-foreground">{selected.providerName ?? t('providerUnavailable')} <span aria-hidden="true">·</span> {selected.embeddingModel} <span aria-hidden="true">·</span> {t('documentCount', { count: selected.documents.length })}</p></div><Button type="button" onClick={() => void deleteBase()} aria-label={t('deleteBase')} title={t('deleteBase')} variant={"ghost"} size={"icon"} className="shrink-0"><Trash2 className="size-4" /></Button></div>
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as KnowledgeTab)}><TabsList className="bg-[var(--workspace-surface,var(--background))]" aria-label={t('viewsLabel')}>{tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id}><tab.icon className="size-4" />{tab.label}</TabsTrigger>)}</TabsList></Tabs>
            </header>
            {error ? <p role="alert" className="mx-5 mt-4 border-l-2 border-destructive pl-3 text-sm text-destructive sm:mx-7">{error}</p> : null}

            {activeTab === 'documents' ? <div className="p-5 sm:p-7">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                <FormSelect label={t('sourceSandbox')} value={sandboxId} onValueChange={setSandboxId} className="min-w-0 flex-1" options={sandboxes.map((sandbox) => ({ value: sandbox.id, label: sandbox.name + (sandbox.running ? '' : ' (' + t('stopped') + ')'), disabled: !sandbox.running }))} />
                <div><Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}><FileUp className="size-4" />{file?.name ?? t('chooseFile')}</Button><input ref={fileInputRef} type="file" accept=".txt,.md,.mdx,.csv,.json,text/plain,text/markdown,text/csv,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="sr-only" /></div>
                <Button type="button" onClick={upload} disabled={busy || !file || !sandboxId}><FileUp className="size-4" />{busy ? t('importing') : t('import')}</Button>
              </div>
              {selected.documents.length ? <DashboardTable minWidth="34rem" ariaLabel={t('documents')} headers={[{ label: t('document') }, { label: t('status'), width: '8rem' }, { label: t('actions'), align: 'right', width: '8rem' }]} rows={selected.documents.map((document) => ({ id: document.id, cells: [
                <div key="document"><div className="flex items-center gap-2"><FileText className="size-4 text-muted-foreground" /><span>{document.filename}</span></div>{document.error ? <p className="mt-1 text-xs text-destructive">{document.error}</p> : null}</div>,
                <AnimatedBadge key="status" status={document.status === 'indexed' ? 'success' : document.status === 'failed' ? 'danger' : document.status === 'indexing' ? 'loading' : 'warning'}>{statusLabels[document.status] ?? document.status}</AnimatedBadge>,
                <div key="actions" className="flex justify-end gap-1"><Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t('reindexDocument')} onClick={() => void reindexDocument(document.id)}><RefreshCw className="size-4" /></Button><Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t('deleteDocument')} onClick={() => void deleteDocument(document.id)}><Trash2 className="size-4" /></Button></div>,
              ] }))} /> : <div className="py-16 text-center"><FileText className="mx-auto size-6 text-muted-foreground" /><h2 className="mt-3 text-sm font-semibold">{t('noDocuments')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('noDocumentsDescription')}</p></div>}
            </div> : null}

            {activeTab === 'recall' ? <div className="mx-auto w-full max-w-4xl p-5 sm:p-7"><div className="flex gap-2 pb-5"><Input onKeyDown={(event) => { if (event.key === 'Enter') void testRecall(); }} placeholder={t('recallPlaceholder')} value={String(recallQuery)} onChange={(value) => setRecallQuery(value)} className="min-w-0 flex-1" /><Button type="button" onClick={testRecall} disabled={busy || !recallQuery.trim()} variant={"primary"} size={"sm"}><Search className="size-4" />{t('search')}</Button></div>{recallResults.length ? <ol className="divide-y divide-border">{recallResults.map((result, index) => <li key={result.chunkId} className="py-5"><div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate text-sm font-medium">{index + 1}. {result.filename}</p><span className="shrink-0 font-mono text-xs text-muted-foreground">{result.score.toFixed(3)}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/90">{result.content}</p><code className="mt-2 block truncate text-[11px] text-muted-foreground">{result.sourcePath}</code></li>)}</ol> : <div className="py-16 text-center"><Search className="mx-auto size-6 text-muted-foreground" /><h2 className="mt-3 text-sm font-semibold">{t('recallEmptyTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('recallEmptyDescription')}</p></div>}</div> : null}

            {activeTab === 'access' ? <div className="mx-auto w-full max-w-3xl p-5 sm:p-7"><div className="pb-4"><h2 className="text-sm font-semibold">{t('agentAccess')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('agentAccessDescription')}</p></div><div className="divide-y divide-border">{agents.map((agent) => { const checked = agentIds.includes(agent.id); return <div key={agent.id} className="flex items-center justify-between gap-4 py-3.5 text-sm"><FormCheckbox checked={checked} disabled={busy} label={agent.name} onCheckedChange={() => void saveAgentBindings(checked ? agentIds.filter((id) => id !== agent.id) : [...agentIds, agent.id])} /></div>; })}</div></div> : null}

            {activeTab === 'settings' ? <div className="mx-auto w-full max-w-3xl p-5 sm:p-7"><div className="grid gap-x-5 gap-y-4 sm:grid-cols-2"><div className="sm:col-span-2 text-xs font-medium text-muted-foreground">{t('name')}<Input  value={String(name)} label={t('name')} onChange={(value) => setName(value)} className="mt-1.5 w-full" /></div><div className="sm:col-span-2 text-xs font-medium text-muted-foreground"><span>{t('embeddingModel')}</span><ModelPicker providers={providers} value={providerId && model ? { providerId, model } : null} onSelect={(selection) => { setProviderId(selection.providerId); setModel(selection.model); }} onConfigure={() => { const returnTo = `/app/${encodeURIComponent(slug)}/knowledge`; window.location.assign(`/app/${encodeURIComponent(slug)}/providers?returnTo=${encodeURIComponent(returnTo)}`); }} trigger={<Button type="button" aria-label={`${t('embeddingModel')}: ${model || t('embeddingModel')}`} variant={"outline"} size={"sm"} className="mt-1.5 flex w-full items-center gap-2 text-left"><Cpu className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{model || t('embeddingModel')}</span><span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></Button>} /></div><div className="text-xs font-medium text-muted-foreground">{t('chunkSize')}<Input min={200} max={8000} type={"number"} value={String(chunkSize)} label={t('chunkSize')} onChange={(value) => setChunkSize(Number(value))} className="mt-1.5 w-full" /></div><div className="text-xs font-medium text-muted-foreground">{t('chunkOverlap')}<Input min={0} type={"number"} value={String(chunkOverlap)} label={t('chunkOverlap')} onChange={(value) => setChunkOverlap(Number(value))} className="mt-1.5 w-full" /></div><div className="text-xs font-medium text-muted-foreground">{t('resultsPerSearch')}<Input min={1} max={20} type={"number"} value={String(topK)} label={t('resultsPerSearch')} onChange={(value) => setTopK(Number(value))} className="mt-1.5 w-full" /></div><div className="text-xs font-medium text-muted-foreground">{t('similarityThreshold')}<Input min={-1} max={1} step={0.05} type={"number"} value={String(threshold)} label={t('similarityThreshold')} onChange={(value) => setThreshold(Number(value))} className="mt-1.5 w-full" /></div></div><div className="mt-6 flex justify-end pt-4"><Button type="button" onClick={saveSettings} disabled={busy || !name.trim() || !providerId || !model.trim()} variant={"primary"} size={"sm"}>{busy ? t('saving') : t('saveSettings')}</Button></div></div> : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}
