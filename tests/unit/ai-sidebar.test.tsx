import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AISidebar, type SidebarResource } from '@/components/agents/ai-sidebar';

const items: SidebarResource[] = [{
  id: 'agent', label: 'Agent', kind: 'project',
  children: [{ id: 'conversation', label: 'Conversation', kind: 'file' }],
}];

describe('AISidebar action isolation', () => {
  it.each([false, true])('keeps the expansion state %s when using a portalled menu action', async (expanded) => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<AISidebar defaultItems={items} defaultExpandedIds={expanded ? ['agent'] : []}
      renderMenu={(_item, controls) => <button type="button" onClick={() => { onAction(); controls.close(); }}>Pin agent</button>} />);
    const row = screen.getByRole('treeitem', { name: /^Agent/ });
    const trigger = within(row).getByRole('button', { name: 'Actions for Agent' });

    await user.click(trigger);
    expect(row).toHaveAttribute('aria-expanded', String(expanded));
    const action = await screen.findByRole('button', { name: 'Pin agent' });
    expect(row).not.toContainElement(action);
    await user.click(action);

    expect(onAction).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveAttribute('aria-expanded', String(expanded));
    await user.click(within(row).getByText('Agent'));
    expect(row).toHaveAttribute('aria-expanded', String(!expanded));
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', String(expanded));
  });

  it.each(['{Enter}', ' '])('activates the menu action with %j without toggling its row', async (key) => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<AISidebar defaultItems={items}
      renderMenu={(_item, controls) => <button type="button" onClick={() => { onAction(); controls.close(); }}>Pin agent</button>} />);
    const row = screen.getByRole('treeitem', { name: /^Agent/ });
    await user.click(within(row).getByRole('button', { name: 'Actions for Agent' }));
    const action = await screen.findByRole('button', { name: 'Pin agent' });
    expect(action).toHaveFocus();
    await user.keyboard(key);

    expect(onAction).toHaveBeenCalledOnce();
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not select or rename a conversation when double-clicking its menu trigger', async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    render(<AISidebar defaultItems={[{ id: 'conversation', label: 'Conversation', kind: 'file' }]} onActiveChange={onActiveChange} />);

    await user.dblClick(screen.getByRole('button', { name: 'Actions for Conversation' }));

    expect(onActiveChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
