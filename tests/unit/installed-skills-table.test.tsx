import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstalledSkillsTable } from '@/components/dashboard/InstalledSkillsTable';

const mocks = vi.hoisted(() => ({ uninstallSkillAction: vi.fn() }));

vi.mock('@/lib/workspace/actions', () => ({ uninstallSkillAction: mocks.uninstallSkillAction }));

const skills = [
  { id: 'skill-1', name: 'First skill', slug: 'first-slug', description: 'Review code', marketManaged: false, iconUrl: null, createdAt: 'Aug 12, 2026' },
  { id: 'skill-2', name: 'Second skill', slug: 'second-slug', description: 'Write docs', marketManaged: false, iconUrl: null, createdAt: 'Aug 11, 2026' },
];

describe('InstalledSkillsTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders skill navigation and selection before client layout measurement', () => {
    const content = document.createElement('div');
    content.innerHTML = renderToStaticMarkup(<InstalledSkillsTable slug="acme" skills={skills} />);

    expect(within(content).getByRole('link', { name: 'First skill' })).toHaveAttribute('href', '/app/acme/skills/skill-1');
    expect(within(within(content).getByRole('row', { name: /Second skill/ })).getByRole('checkbox')).not.toBeChecked();
  });

  it('opens details from the full skill cell and retains an individual delete action', async () => {
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    const link = await screen.findByRole('link', { name: 'First skill' });
    expect(link).toHaveAttribute('href', '/app/acme/skills/skill-1');
    await userEvent.click(screen.getByRole('button', { name: 'Actions: First skill' }));
    expect(screen.getByRole('button', { name: 'Uninstall: First skill' })).toBeEnabled();
  });

  it('only shows the batch action after selection, then clears and submits selected skills after confirmation', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall (2)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    const toolbar = screen.getByRole('toolbar', { name: '2 selected' });
    expect(within(toolbar).getByRole('button', { name: 'Uninstall (2)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('0 selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall (2)' })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('row', { name: /First skill/ })).getByRole('checkbox'));
    await user.click(within(screen.getByRole('row', { name: /Second skill/ })).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Uninstall (2)' }));
    expect(mocks.uninstallSkillAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.getAll('installId')).toEqual(['skill-1', 'skill-2']);
  });

  it('submits an individual skill deletion only after confirmation', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    await user.click(await screen.findByRole('button', { name: 'Actions: First skill' }));
    await user.click(await screen.findByRole('button', { name: 'Uninstall: First skill' }));
    expect(mocks.uninstallSkillAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.getAll('installId')).toEqual(['skill-1']);
  });

  it('drops selections for skills removed by a server refresh', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InstalledSkillsTable slug="acme" skills={skills} />);

    await user.click(within(await screen.findByRole('row', { name: /First skill/ })).getByRole('checkbox'));
    await user.click(within(screen.getByRole('row', { name: /Second skill/ })).getByRole('checkbox'));
    rerender(<InstalledSkillsTable slug="acme" skills={[skills[0]]} />);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Uninstall (1)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.getAll('installId')).toEqual(['skill-1']);
  });

  it('paginates, searches descriptions and slugs, and clamps after removal', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 21 }, (_, index) => ({ ...skills[0], id: `skill-${index}`, name: `Skill ${index}`, slug: `unique-${index}`, description: `Description ${index}` }));
    const { rerender } = render(<InstalledSkillsTable slug="acme" skills={items} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: 'Skill 20' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search skills...' }), ' DESCRIPTION 0 ');
    expect(screen.getByRole('link', { name: 'Skill 0' })).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Search skills...' }));
    await user.type(screen.getByRole('textbox', { name: 'Search skills...' }), 'unique-20');
    expect(screen.getByRole('link', { name: 'Skill 20' })).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Search skills...' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    rerender(<InstalledSkillsTable slug="acme" skills={items.slice(0, 1)} />);
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skill 0' })).toBeInTheDocument();
  });

  it('blocks mixed managed selections without partially uninstalling', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={[skills[0], { ...skills[1], marketManaged: true }]} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    const toolbar = screen.getByRole('toolbar');
    expect(within(toolbar).queryByRole('button', { name: /Uninstall/ })).not.toBeInTheDocument();
    expect(within(toolbar).getByRole('link', { name: 'Manage market installation' })).toHaveAttribute('href', '/app/acme/market/installed');
    expect(mocks.uninstallSkillAction).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('row', { name: /Second skill/ })).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Uninstall (1)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    expect((mocks.uninstallSkillAction.mock.calls[0][0] as FormData).getAll('installId')).toEqual(['skill-1']);
  });

  it('preserves hidden selections while limiting actions to visible skills and clears all', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={skills} />);
    await user.click(within(await screen.findByRole('row', { name: /First skill/ })).getByRole('checkbox'));
    const search = screen.getByRole('textbox', { name: 'Search skills...' });
    await user.type(search, 'second');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('row', { name: /Second skill/ })).getByRole('checkbox'));
    expect(new FormData(screen.getByRole('toolbar').querySelector('form')!).getAll('installId')).toEqual(['skill-2']);
    await user.clear(search);
    expect(screen.getByRole('toolbar', { name: '2 selected' })).toBeInTheDocument();
    await user.type(search, 'second');
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    await user.clear(search);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
