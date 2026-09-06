import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkComposer } from '@/components/dashboard/work/WorkComposer';
import { McpPromptPickerButton } from '@/components/dashboard/McpPromptPickerButton';
import { ComposerPromptManager } from '@/components/dashboard/work/ComposerPromptManager';
import { ComposerReferencesSchema, composerTrigger, type ComposerReference } from '@/lib/work/composer-types';
import { runtimeCommands } from '@/lib/agents/runtime-commands';

function Composer({ sandboxId = 'sandbox-1', onSubmit = vi.fn(), runtimeKind }: { sandboxId?: string; runtimeKind?: string; onSubmit?: (references: ComposerReference[]) => void }) {
  const [draft, setDraft] = useState('');
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <><WorkComposer key={sandboxId} agentId="agent-1" sandboxId={sandboxId} workSessionId="work-1" conversationId="conversation-1"
    commands={runtimeKind ? runtimeCommands(runtimeKind) : []}
    draft={draft} onDraftChange={setDraft} references={references} onReferencesChange={setReferences}
    attachments={attachments} onAttachmentsChange={setAttachments} disabled={false} supportsAttachments
    onSubmit={() => onSubmit(references)} onNewTask={() => setDraft('')} onPendingChange={setPending} onError={setError}
    toolbarStart={null} toolbarEnd={<button type="submit" disabled={pending}>Send</button>} />{error ? <p role="alert">{error}</p> : null}</>;
}

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
const input = () => screen.getByRole('combobox', { name: 'What should the Agent accomplish?' });
async function customize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open tools' }));
  await user.click(screen.getByRole('button', { name: 'Customize toolbar' }));
  return screen.getByRole('dialog');
}

describe('Work composer', () => {
  it.each(['pi', 'claude-code', 'dsh'])('offers only %s commands through /, completes without executing, and keeps + unchanged', async (runtimeKind) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer runtimeKind={runtimeKind} onSubmit={onSubmit} />);
    await user.type(input(), '/');
    const names = runtimeCommands(runtimeKind).map((item) => `/${item.name}`);
    expect(screen.getAllByRole('option')).toHaveLength(6 + names.length);
    for (const name of names) expect(screen.getByRole('option', { name: new RegExp(name) })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /\/compact/ }));
    expect(input()).toHaveValue('/compact ');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    await user.clear(input());
    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect(screen.queryByRole('option', { name: /\/compact/ })).not.toBeInTheDocument();
  });

  it('pins, reorders, persists and resets the toolbar without duplicating pinned menu actions', async () => {
    const user = userEvent.setup();
    const first = render(<Composer />);
    const dialog = await customize(user);
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Skills' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'MCP resources' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move MCP resources up' }));
    expect(JSON.parse(localStorage.getItem('toolplane.work.composer.toolbar')!)).toEqual(['resources', 'skills']);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect([...document.querySelectorAll('[data-composer-shortcut]')].map((el) => el.getAttribute('data-composer-shortcut'))).toEqual(['resources', 'skills']);
    first.unmount();
    render(<Composer />);
    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.queryByRole('option', { name: 'Skills' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await user.click(screen.getByRole('button', { name: 'Skills' }));
    expect(screen.getByRole('listbox', { name: 'Skills' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('section=skills');
    await user.keyboard('{Escape}');
    const resetDialog = await customize(user);
    await user.click(within(resetDialog).getByRole('button', { name: 'Restore default toolbar' }));
    expect(within(resetDialog).getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    await user.click(within(resetDialog).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[data-composer-shortcut]')).toBeNull();
    await user.type(input(), '/');
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('resolves current-sandbox references, blocks premature send, and aborts a late result after switching', async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(Response.json({ items: [{ kind: 'file', id: 'src/plan.md', label: 'src/plan.md' }, { kind: 'session', id: 'previous', label: 'Previous task' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} />);
    await user.type(input(), 'Review @');
    await user.click(await screen.findByRole('option', { name: 'src/plan.md' }));
    expect(input()).toHaveValue('Review ');
    expect(input()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.submit(input().closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toContain('sandboxId=sandbox-1');
    expect(fetchMock.mock.calls[0][0]).toContain('excludeConversationId=conversation-1');
    const reference = { kind: 'file', id: 'src/plan.md', label: 'src/plan.md', text: 'Reference material: actual sandbox plan' };
    await act(async () => finish(Response.json(reference)));
    expect(screen.getByText('src/plan.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith([reference]);
    await user.click(screen.getByRole('button', { name: 'Remove reference: src/plan.md' }));
    await user.type(input(), '@');
    await user.click(await screen.findByRole('option', { name: 'Previous task' }));
    const pendingSignal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
    rerender(<Composer sandboxId="sandbox-2" onSubmit={onSubmit} />);
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => finish(Response.json({ ...reference, kind: 'session', id: 'previous', label: 'Previous task' })));
    expect(screen.queryByText('Previous task')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('does not insert a late MCP prompt after the picker is canceled', async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(Response.json({ prompts: [{ deploymentId: 'dep', serverName: 'Tools', name: 'Review', arguments: [] }] }))));
    const onInsert = vi.fn();
    render(<McpPromptPickerButton apiPath="/prompts" disabled={false} onError={vi.fn()} onInsert={onInsert} />);
    await user.click(screen.getByRole('button'));
    await user.click(await screen.findByRole('button', { name: /Review/ }));
    await user.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => finish(Response.json({ text: 'Stale prompt' })));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('edits persisted prompts without submitting database metadata', async () => {
    const user = userEvent.setup();
    let prompt = { id: 'saved', agentId: 'agent-1', title: 'Review', content: 'Keep paths.', createdAt: '2026-09-06' };
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') prompt = { ...prompt, ...JSON.parse(String(init.body)) };
      return Promise.resolve(Response.json(init?.method === 'POST' ? { ok: true } : { prompts: [prompt] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ComposerPromptManager agentId="agent-1" onClose={vi.fn()} onInsert={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Edit prompt: Review' }));
    const content = screen.getByRole('textbox', { name: 'Prompt content' });
    await user.clear(content);
    await user.type(content, 'Preserve the release checklist.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Edit prompt: Review' });
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'save', id: 'saved', title: 'Review', content: 'Preserve the release checklist.' });
  });

  it('bounds reference payloads and detects only unselected trigger tokens at the caret', () => {
    const reference = { kind: 'file', id: 'plan', label: 'Plan', text: 'Context' };
    expect(ComposerReferencesSchema.safeParse([reference]).success).toBe(true);
    expect(ComposerReferencesSchema.safeParse(Array(11).fill(reference)).success).toBe(false);
    expect(ComposerReferencesSchema.safeParse(Array(4).fill({ ...reference, text: 'x'.repeat(20_000) })).success).toBe(false);
    expect(composerTrigger('Review @src/file.md after', 19)).toMatchObject({ symbol: '@', query: 'src/file.md', start: 7, end: 19 });
    expect(composerTrigger('https://test/path', 17)).toBeNull();
    expect(composerTrigger('/tmp/file', 9)).toBeNull();
    expect(composerTrigger('/task', 5, 4)).toBeNull();
  });
});
