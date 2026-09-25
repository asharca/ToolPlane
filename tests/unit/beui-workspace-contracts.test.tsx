import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkspaceTabBar, type WorkspaceTab } from '@/components/ui/beui/components/workspace/workspace-tab-bar';
import { WorkspaceShell } from '@/components/ui/beui/components/workspace/workspace-shell';

// jsdom does not supply these browser APIs. Actual viewport/layout is verified in CI Chromium.
beforeAll(() => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => vi.unstubAllGlobals());
// Real registry source, no UI or Motion stubs. The host retains state and vetoes.
const tabs: WorkspaceTab[] = [{ id: 'a', title: 'Pinned', pinned: true }, { id: 'b', title: 'Agents' }, { id: 'c', title: 'Settings' }];
describe('registry workspace behavior', () => {
  it('preserves uncontrolled drafts when the controlled sidebar folds', async () => {
    const view = (open: boolean) => <WorkspaceShell open={open} sidebar={<aside>Navigation</aside>}><input aria-label="Draft" defaultValue="original" /></WorkspaceShell>;
    const { rerender } = render(view(true)); const input = screen.getByRole('textbox');
    await userEvent.type(input, ' edited'); rerender(view(false));
    expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('original edited');
    expect(document.querySelector('[data-workspace-shell]')).toHaveAttribute('data-state', 'collapsed');
  });
  it('keeps selection host-owned and gives a missing selection a tabbable fallback', () => {
    const onSelect = vi.fn(); const { rerender } = render(<WorkspaceTabBar tabs={tabs} activeTabId="a" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' })); expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: 'Pinned' })).toHaveAttribute('aria-selected', 'true');
    rerender(<WorkspaceTabBar tabs={tabs} activeTabId="missing" onSelect={onSelect} />);
    expect(screen.getByRole('tab', { name: 'Pinned' })).toHaveAttribute('tabindex', '0');
  });
  it('supports arrows, Home and End without moving control focus into a tab button', () => {
    const onSelect = vi.fn(); render(<WorkspaceTabBar tabs={tabs} activeTabId="b" onSelect={onSelect} onClose={vi.fn()} />);
    const tab = screen.getByRole('tab', { name: 'Agents' });
    fireEvent.keyDown(tab, { key: 'ArrowRight' }); expect(onSelect).toHaveBeenLastCalledWith('c'); expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
    fireEvent.keyDown(tab, { key: 'Home' }); expect(onSelect).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(tab, { key: 'End' }); expect(onSelect).toHaveBeenLastCalledWith('c');
    expect(tab.querySelector('button')).toBeNull();
  });
  it('rejects reorder across pinned groups but permits keyboard reorder within a group', () => {
    const onReorder = vi.fn(); render(<WorkspaceTabBar tabs={tabs} activeTabId="b" onSelect={vi.fn()} onReorder={onReorder} />);
    const tab = screen.getByRole('tab', { name: 'Agents' });
    fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true }); expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(tab, { key: 'ArrowRight', altKey: true }); expect(onReorder).toHaveBeenCalledWith('b', 'c');
  });
  it('cannot close a pinned, nonclosable or final tab through keyboard or pointer shortcuts', () => {
    const onClose = vi.fn(); const { rerender } = render(<WorkspaceTabBar tabs={[tabs[0], { ...tabs[1], closable: false }]} activeTabId="a" onSelect={vi.fn()} onClose={onClose} closeOnDoubleClick />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Pinned' }), { key: 'Delete' });
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Agents' }));
    rerender(<WorkspaceTabBar tabs={[tabs[1]]} activeTabId="b" onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Delete' });
    expect(onClose).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Close Agents' })).toBeDisabled();
  });
  it('requests closing once and restores focus only after the host removes a tab', async () => {
    const onClose = vi.fn(); const { rerender } = render(<WorkspaceTabBar tabs={tabs} activeTabId="b" onSelect={vi.fn()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
    expect(onClose).toHaveBeenCalledTimes(1); expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    rerender(<WorkspaceTabBar tabs={[tabs[0], tabs[2]]} activeTabId="c" onSelect={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
  });
  it('opens the registry action menu with localized labels and permits a single pin decision', async () => {
    const onPinnedChange = vi.fn(); render(<WorkspaceTabBar tabs={tabs} activeTabId="b" onSelect={vi.fn()} onPinnedChange={onPinnedChange} labels={{ actions: title => `Actions for ${title}`, pin: title => `Pin ${title}` }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Agents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Actions for Agents' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pin Agents' }));
    expect(onPinnedChange).toHaveBeenCalledExactlyOnceWith('b', true);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveFocus();
  });
  it('does not steal an editor bold shortcut when a workspace shell is mounted', () => {
    const change = vi.fn(); render(<WorkspaceShell open onOpenChange={change}><textarea aria-label="Editor" /></WorkspaceShell>);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'b', ctrlKey: true }); expect(change).not.toHaveBeenCalled();
  });
  it('uses only the host callback for opening a new window', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null); const request = vi.fn();
    render(<WorkspaceTabBar tabs={tabs} activeTabId="b" onSelect={vi.fn()} onOpenInNewWindow={request} quickActions />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Agents in new window' }));
    expect(request).toHaveBeenCalledExactlyOnceWith('b'); expect(open).not.toHaveBeenCalled();
  });
});
