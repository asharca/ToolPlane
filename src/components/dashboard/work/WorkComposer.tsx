'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Database, FileText, Folder, GripVertical, Loader2, MessageSquare, Paperclip, Plus, RotateCcw, ScrollText, Search, SlidersHorizontal, Sparkles, SquarePen, TerminalSquare, X, type LucideIcon } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/Dialog';
import {
  ConversationAttachmentChip, ConversationAttachmentRemoveButton, ConversationComposerExpand,
  conversationComposerClassName, conversationComposerInputClassName, conversationComposerToolbarClassName, useConversationComposerExpansion,
} from '@/components/dashboard/ConversationComposer';
import { McpPromptPickerButton } from '@/components/dashboard/McpPromptPickerButton';
import { ComposerPromptManager } from './ComposerPromptManager';
import { composerTrigger, ComposerReferencesSchema, type ComposerItem, type ComposerReference } from '@/lib/work/composer-types';
import { parseRuntimeCommand, type RuntimeCommand } from '@/lib/agents/runtime-commands';

type Panel = {
  source: 'button' | '/' | '@';
  view: 'root' | 'references' | 'resources' | 'skills';
  query: string;
  start: number;
  end: number;
  index: number;
};
type Option = { id: string; label: string; description?: string; icon: LucideIcon; disabled?: boolean; group?: string; item?: ComposerItem; command?: string };
const referenceIcon = { file: FileText, folder: Folder, session: MessageSquare, resource: Database, skill: Sparkles };
const TOOLBAR_KEY = 'toolplane.work.composer.toolbar';
const TOOLBAR_EVENT = 'toolplane:work-composer-toolbar';
function subscribeToolbar(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(TOOLBAR_EVENT, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(TOOLBAR_EVENT, listener); };
}
function readToolbar() {
  try { return localStorage.getItem(TOOLBAR_KEY) ?? '[]'; } catch { return '[]'; }
}

export function WorkComposer({
  agentId, sandboxId, workSessionId, conversationId, draft, onDraftChange, attachments, onAttachmentsChange,
  references, onReferencesChange, disabled, supportsAttachments, onSubmit, onNewTask, onError, onPendingChange,
  waitingQuestion, toolbarStart, toolbarEnd, commands = [],
}: {
  agentId?: string; sandboxId?: string; workSessionId?: string; conversationId?: string;
  draft: string; onDraftChange: (text: string) => void;
  attachments: File[]; onAttachmentsChange: (files: File[]) => void;
  references: ComposerReference[]; onReferencesChange: (references: ComposerReference[]) => void;
  disabled: boolean; supportsAttachments: boolean; onSubmit: (event: FormEvent) => void;
  onNewTask: () => void; onError: (text: string | null) => void; onPendingChange: (pending: boolean) => void;
  waitingQuestion?: string | null; toolbarStart: ReactNode; toolbarEnd: ReactNode;
  commands?: readonly RuntimeCommand[];
}) {
  const t = useTranslations('console.workComposer');
  const agentsT = useTranslations('console.agents');
  const workT = useTranslations('console.work');
  const common = useTranslations('common');
  const commandsT = useTranslations('console.runtimeCommands');
  const { expanded, inputRef, minRows, toggle } = useConversationComposerExpansion();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const toolbarValue = useSyncExternalStore(subscribeToolbar, readToolbar, () => '[]');
  const [loaded, setLoaded] = useState<{ key: string; items: ComposerItem[]; error?: string; filesUnavailable?: boolean }>({ key: '', items: [] });
  const formRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const insertionRef = useRef({ start: 0, end: 0 });
  const requestRef = useRef<AbortController | null>(null);
  const menuId = useId();
  const endpoint = agentId ? `/api/v1/agents/${encodeURIComponent(agentId)}/composer` : '';
  const section = panel?.view !== 'root' ? panel?.view : undefined;
  const query = panel?.query ?? '';
  const requestKey = section ? JSON.stringify([section, query, endpoint, sandboxId, workSessionId, conversationId]) : '';
  const loadFailed = t('loadFailed');

  useEffect(() => {
    if (!section || !endpoint) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ section, query, ...(sandboxId ? { sandboxId } : {}), ...(workSessionId ? { workSessionId } : {}), ...(conversationId ? { excludeConversationId: conversationId } : {}) });
      void fetch(`${endpoint}?${params}`, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
        if (!response.ok) throw new Error(loadFailed);
        const data = await response.json();
        if (!controller.signal.aborted) setLoaded({ key: requestKey, items: data.items, filesUnavailable: data.filesUnavailable });
      }).catch(() => { if (!controller.signal.aborted) setLoaded({ key: requestKey, items: [], error: loadFailed }); });
    }, section === 'references' ? 200 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [section, query, endpoint, sandboxId, workSessionId, conversationId, requestKey, loadFailed]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!formRef.current?.contains(event.target as Node)) setPanel(null); };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); requestRef.current?.abort(); onPendingChange(false); };
  }, [onPendingChange]);

  useEffect(() => {
    if (panel?.source === 'button') searchRef.current?.focus();
  }, [panel?.source, panel?.view]);

  function focusInput(position?: number) {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (position !== undefined) inputRef.current?.setSelectionRange(position, position);
    });
  }

  function consumeTrigger() {
    const start = panel?.start ?? inputRef.current?.selectionStart ?? draft.length;
    const end = panel?.end ?? inputRef.current?.selectionEnd ?? start;
    const next = draft.slice(0, start) + draft.slice(end);
    onDraftChange(next);
    insertionRef.current = { start, end: start };
    return start;
  }

  function insertText(text: string) {
    const { start, end } = insertionRef.current;
    const next = draft.slice(0, start) + text + draft.slice(end);
    if (next.length > 20_000) { onError(t('inputTooLong')); return; }
    onDraftChange(next);
    focusInput(start + text.length);
  }

  function openSection(view: NonNullable<typeof section>) {
    const start = consumeTrigger();
    setPanel({ source: 'button', view, query: '', start, end: start, index: 0 });
  }

  async function chooseReference(item: ComposerItem) {
    if (item.kind === 'folder') {
      const start = consumeTrigger();
      setPanel({ source: 'button', view: 'references', query: `${item.id}/`, start, end: start, index: 0 });
      return;
    }
    const start = consumeTrigger();
    setPanel(null);
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setResolving(true);
    onPendingChange(true);
    onError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        kind: item.kind, id: item.id, ...(item.deploymentId ? { deploymentId: item.deploymentId } : {}), ...(sandboxId ? { sandboxId } : {}), ...(workSessionId ? { workSessionId } : {}),
      }) });
      if (!response.ok) throw new Error(t('referenceFailed'));
      const reference = await response.json() as ComposerReference;
      const next = ComposerReferencesSchema.safeParse([...references, reference]);
      if (!next.success) throw new Error(t('referenceLimit'));
      if (!controller.signal.aborted) { onReferencesChange(next.data); focusInput(start); }
    } catch (cause) { if (!controller.signal.aborted) { onDraftChange(draft); onError(cause instanceof Error ? cause.message : t('referenceFailed')); } }
    finally { if (!controller.signal.aborted) { setResolving(false); onPendingChange(false); } }
  }

  const rootOptions: Option[] = [
    { id: 'attachments', label: agentsT('addAttachment'), icon: Paperclip, disabled: !supportsAttachments },
    { id: 'prompts', label: t('prompts'), icon: SquarePen, disabled: !agentId },
    { id: 'mcp-prompts', label: agentsT('mcpPrompts'), icon: ScrollText, disabled: !agentId },
    { id: 'resources', label: t('resources'), icon: Database, disabled: !agentId },
    { id: 'skills', label: t('skills'), icon: Sparkles, disabled: !agentId },
    { id: 'new-task', label: t('newTask'), icon: Plus, disabled: !agentId },
  ];
  let pinnedIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(toolbarValue);
    if (Array.isArray(parsed)) pinnedIds = [...new Set(parsed)].filter((id): id is string => typeof id === 'string' && rootOptions.some((option) => option.id === id));
  } catch { /* Ignore obsolete or invalid browser preferences. */ }
  const pinnedOptions = pinnedIds.flatMap((id) => rootOptions.find((option) => option.id === id) ?? []);

  function saveToolbar(ids: string[]) {
    try { localStorage.setItem(TOOLBAR_KEY, JSON.stringify(ids)); window.dispatchEvent(new Event(TOOLBAR_EVENT)); }
    catch { onError(t('toolbarSaveFailed')); }
  }

  function moveShortcut(index: number, offset: number) {
    const next = [...pinnedIds];
    const [id] = next.splice(index, 1);
    next.splice(index + offset, 0, id);
    saveToolbar(next);
  }
  const loading = Boolean(section && endpoint && loaded.key !== requestKey);
  const commandOptions: Option[] = panel?.source === '/' && !draft.slice(0, panel.start).trim() ? commands.map((command) => ({
    id: `command:${command.name}`, label: `/${command.name}`, command: command.name, icon: TerminalSquare, group: commandsT('title'),
    description: commandsT.has(`descriptions.${command.name}`) ? commandsT(`descriptions.${command.name}`) : command.description,
  })) : [];
  const options: Option[] = panel?.view === 'root'
    ? [...rootOptions.filter((item) => !pinnedIds.includes(item.id)), ...commandOptions].filter((item) => `${item.label} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    : (loaded.key === requestKey ? loaded.items : []).filter((item) => panel?.view === 'references' || `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).map((item) => ({
      id: `${item.kind}:${item.deploymentId ?? ''}:${item.id}`, label: item.label, description: item.description,
      icon: referenceIcon[item.kind], group: item.kind === 'session' ? t('sessions') : item.kind === 'file' || item.kind === 'folder' ? t('files') : undefined,
      disabled: references.some((ref) => ref.kind === item.kind && ref.id === item.id && ref.deploymentId === item.deploymentId), item,
    }));
  const activeIndex = Math.min(panel?.index ?? 0, Math.max(0, options.length - 1));
  const menuOpen = Boolean(panel && !disabled && !resolving);

  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [menuOpen, menuId, activeIndex]);

  function updateTrigger(input: HTMLTextAreaElement) {
    const trigger = composerTrigger(input.value, input.selectionStart, input.selectionEnd);
    if (!trigger || (trigger.symbol === '/' && /^new$/i.test(trigger.query))) { setPanel(null); return; }
    setPanel({ ...trigger, source: trigger.symbol, view: trigger.symbol === '/' ? 'root' : 'references', index: 0 });
  }

  function activateOption(option: Option) {
    if (option.disabled) return;
    if (option.command) {
      const start = panel?.start ?? 0;
      const end = panel?.end ?? draft.length;
      const text = `/${option.command} `;
      onDraftChange(draft.slice(0, start) + text + draft.slice(end));
      setPanel(null);
      focusInput(start + text.length);
      return;
    }
    if (option.item) { void chooseReference(option.item); return; }
    if (option.id === 'resources' || option.id === 'skills') { openSection(option.id); return; }
    consumeTrigger();
    setPanel(null);
    if (option.id === 'attachments') fileRef.current?.click();
    if (option.id === 'prompts') setPromptsOpen(true);
    if (option.id === 'mcp-prompts') setMcpOpen(true);
    if (option.id === 'new-task') onNewTask();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && event.key.startsWith('Arrow')) setPanel(null);
    if (menuOpen && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPanel(null); focusInput(); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (options.length) setPanel((current) => current && { ...current, index: (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab' && event.currentTarget === searchRef.current) return;
        if (!options.length && event.key === 'Enter' && event.currentTarget === inputRef.current && parseRuntimeCommand(draft)) { event.preventDefault(); setPanel(null); event.currentTarget.form?.requestSubmit(); return; }
        event.preventDefault();
        if (options[activeIndex]) activateOption(options[activeIndex]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && event.currentTarget === inputRef.current) {
      event.preventDefault();
      if (!resolving) event.currentTarget.form?.requestSubmit();
    }
  }

  return <>
    <form ref={formRef} data-ui="chat.composer" data-composer-inputbar="" data-composer-presentation="regular" className={conversationComposerClassName}
      onSubmit={(event) => { event.preventDefault(); if (!resolving) onSubmit(event); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPanel(null); }}>
      {menuOpen && panel ? <div id={menuId} data-ui="composer.menu" className="absolute inset-x-0 bottom-full z-30 mb-2 flex max-h-[min(24rem,50dvh)] flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        <header className="flex shrink-0 items-center gap-2 px-2 py-1.5">
          {panel.view !== 'root' ? <button type="button" aria-label={common('back')} title={common('back')} className="ui-button-ghost ui-icon-button" onClick={() => setPanel({ ...panel, view: 'root', query: '', index: 0 })}><ChevronLeft className="size-4" /></button> : <Plus className="size-4 text-muted-foreground" />}
          {panel.source === 'button' ? <input ref={searchRef} value={panel.query} onChange={(event) => setPanel({ ...panel, query: event.target.value, index: 0 })} onKeyDown={keyDown} role="combobox" aria-expanded aria-controls={`${menuId}-list`} aria-activedescendant={options.length ? `${menuId}-${activeIndex}` : undefined} aria-label={t('search')} placeholder={t('search')} className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none" /> : <span className="text-xs font-medium text-muted-foreground">{t(panel.view === 'root' ? 'tools' : 'references')}</span>}
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Search className="ml-auto size-3.5 text-muted-foreground" />}
        </header>
        <div role="listbox" id={`${menuId}-list`} aria-label={t(panel.view === 'root' ? 'tools' : panel.view)} className="min-h-0 overflow-y-auto">
          {options.map(({ id, label, description, icon: Icon, disabled: unavailable, group }, index) => <div key={id} role="presentation">
            {group && group !== options[index - 1]?.group ? <div role="presentation" className="px-3 py-1 text-[11px] font-medium text-muted-foreground">{group}</div> : null}
            <button id={`${menuId}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === activeIndex} aria-disabled={unavailable} disabled={unavailable}
              onMouseDown={(event) => event.preventDefault()} onPointerMove={() => setPanel({ ...panel, index })} onClick={() => activateOption(options[index])}
              className={`flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left disabled:opacity-40 ${index === activeIndex ? 'bg-muted' : 'hover:bg-muted/60'}`}>
              <Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block break-words text-sm">{label}</span>{description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}</span>
              {['resources', 'skills', 'prompts', 'mcp-prompts'].includes(id) ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            </button>
          </div>)}
          {!loading && !options.length ? <p className="px-3 py-6 text-center text-xs text-muted-foreground">{loaded.key === requestKey && loaded.error ? loaded.error : t('empty')}</p> : null}
        </div>
        {section === 'references' && loaded.key === requestKey && loaded.filesUnavailable ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t('filesUnavailable')}</p> : null}
        {panel.view === 'root' ? <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { consumeTrigger(); setPanel(null); setCustomizing(true); }} className="mt-1 flex shrink-0 items-center gap-3 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"><SlidersHorizontal className="size-4" />{t('customizeToolbar')}</button> : null}
      </div> : null}
      <ConversationComposerExpand expanded={expanded} onToggle={toggle} />
      {waitingQuestion ? <p className="px-[15px] pb-2 pt-1 text-xs font-medium">{waitingQuestion}</p> : null}
      {attachments.length || references.length || resolving ? <div className="flex flex-wrap gap-1 px-[15px] pb-1">
        {attachments.map((file, index) => <ConversationAttachmentChip key={`${file.name}-${index}`} name={file.name} thumbnail={<FileText className="size-3.5 text-muted-foreground" />} removeButton={<ConversationAttachmentRemoveButton label={agentsT('removeAttachment', { name: file.name })} onClick={() => onAttachmentsChange(attachments.filter((_, position) => position !== index))} />} />)}
        {references.map((reference, index) => { const Icon = referenceIcon[reference.kind]; return <ConversationAttachmentChip key={`${reference.kind}:${reference.deploymentId ?? ''}:${reference.id}`} name={reference.label} thumbnail={<Icon className="size-3.5 text-muted-foreground" />} removeButton={<ConversationAttachmentRemoveButton label={t('removeReference', { name: reference.label })} onClick={() => onReferencesChange(references.filter((_, position) => position !== index))} />} />; })}
        {resolving ? <Loader2 aria-label={common('loading')} className="my-1 size-4 animate-spin text-muted-foreground" /> : null}
      </div> : null}
      <textarea ref={inputRef} value={draft} role="combobox" aria-label={workT('taskPlaceholder')} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={menuOpen} aria-controls={menuOpen ? `${menuId}-list` : undefined} aria-activedescendant={menuOpen && options.length ? `${menuId}-${activeIndex}` : undefined}
        readOnly={resolving} maxLength={20_000} onChange={(event) => { onDraftChange(event.target.value); updateTrigger(event.target); }} onKeyDown={keyDown}
        onSelect={(event) => { if (panel?.source !== 'button' && panel && !composerTrigger(draft, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)) setPanel(null); }}
        placeholder={t('hint')} rows={minRows} className={conversationComposerInputClassName(expanded)} />
      <input ref={fileRef} type="file" multiple hidden onChange={(event) => { const files = [...attachments, ...Array.from(event.target.files ?? [])]; if (files.length > 5) onError(agentsT('attachmentLimitReached', { count: 5 })); onAttachmentsChange(files.slice(0, 5)); event.target.value = ''; focusInput(); }} />
      <div data-ui="part:composer-actions" data-composer-toolbar="" className={conversationComposerToolbarClassName}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <button type="button" disabled={disabled || resolving} aria-label={agentsT('openComposerTools')} title={agentsT('openComposerTools')} aria-haspopup="listbox" aria-expanded={menuOpen && panel?.view === 'root'}
            onClick={() => { const start = inputRef.current?.selectionStart ?? draft.length; setPanel(menuOpen ? null : { source: 'button', view: 'root', query: '', start, end: inputRef.current?.selectionEnd ?? start, index: 0 }); }}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"><Plus className="size-[18px]" /></button>
          {pinnedOptions.map((option) => { const Icon = option.icon; return <button key={option.id} type="button" data-composer-shortcut={option.id} disabled={disabled || resolving || option.disabled} aria-label={option.label} title={option.label} onClick={() => activateOption(option)} className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"><Icon className="size-[17px]" /></button>; })}
          {toolbarStart}
        </div>
        <div className="flex shrink-0 items-center gap-2">{toolbarEnd}</div>
      </div>
    </form>
    {agentId && <McpPromptPickerButton apiPath={`/api/v1/agents/${encodeURIComponent(agentId)}/prompts`} disabled={disabled} open={mcpOpen} onOpenChange={setMcpOpen} hideTrigger onError={onError} onInsert={insertText} />}
    {agentId && promptsOpen ? <ComposerPromptManager agentId={agentId} onClose={() => { setPromptsOpen(false); focusInput(); }} onInsert={insertText} /> : null}
    <Dialog open={customizing} onOpenChange={(open) => { setCustomizing(open); if (!open) focusInput(); }}>
      <DialogPortal><DialogOverlay /><DialogContent aria-describedby={undefined} className="!max-h-[calc(100dvh-2rem)] !max-w-md !overflow-y-auto !rounded-lg">
        <header className="flex items-center justify-between gap-3"><DialogTitle className="!text-base !tracking-normal">{t('customizeToolbar')}</DialogTitle><DialogClose asChild><button type="button" aria-label={common('close')} title={common('close')} className="ui-button-ghost ui-icon-button"><X className="size-4" /></button></DialogClose></header>
        <div className="mt-3 divide-y divide-border">
          {[...pinnedOptions, ...rootOptions.filter((option) => !pinnedIds.includes(option.id))].map((option) => {
            const index = pinnedIds.indexOf(option.id);
            const Icon = option.icon;
            return <div key={option.id} draggable={index >= 0} onDragStart={(event) => { event.dataTransfer.setData('text/plain', option.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => { if (index >= 0) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const from = pinnedIds.indexOf(event.dataTransfer.getData('text/plain')); if (from >= 0 && index >= 0) moveShortcut(from, index - from); }} className="flex min-h-11 items-center gap-2 py-1">
              <GripVertical aria-hidden className={`size-4 shrink-0 ${index >= 0 ? 'cursor-grab text-muted-foreground' : 'invisible'}`} />
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm"><input type="checkbox" checked={index >= 0} onChange={(event) => saveToolbar(event.target.checked ? [...pinnedIds, option.id] : pinnedIds.filter((id) => id !== option.id))} className="accent-brand" /><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-words">{option.label}</span></label>
              {index >= 0 ? <><button type="button" disabled={index === 0} aria-label={t('moveShortcutUp', { name: option.label })} title={t('moveShortcutUp', { name: option.label })} onClick={() => moveShortcut(index, -1)} className="ui-button-ghost ui-icon-button"><ArrowUp className="size-3.5" /></button><button type="button" disabled={index === pinnedIds.length - 1} aria-label={t('moveShortcutDown', { name: option.label })} title={t('moveShortcutDown', { name: option.label })} onClick={() => moveShortcut(index, 1)} className="ui-button-ghost ui-icon-button"><ArrowDown className="size-3.5" /></button></> : null}
            </div>;
          })}
        </div>
        <footer className="mt-3 flex justify-end border-t border-border pt-3"><button type="button" disabled={!pinnedIds.length} onClick={() => saveToolbar([])} className="ui-button-secondary text-xs"><RotateCcw className="size-3.5" />{t('resetToolbar')}</button></footer>
      </DialogContent></DialogPortal>
    </Dialog>
  </>;
}
