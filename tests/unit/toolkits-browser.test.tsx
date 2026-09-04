import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolkitsBrowser, type ToolkitRow } from '@/components/dashboard/ToolkitsBrowser';

vi.mock('@/lib/toolkits/actions', () => ({
  createToolkitAction: vi.fn(),
  updateToolkitAvailabilityAction: vi.fn(),
}));

const toolkits: ToolkitRow[] = [
  {
    id: 'toolkit-1',
    name: 'Research stack',
    slug: 'research-stack',
    visibility: 'private',
    enabled: true,
    toolCount: 3,
    created: 'Jul 15, 2026',
  },
  {
    id: 'toolkit-2',
    name: 'Public utilities',
    slug: 'public-utilities',
    visibility: 'public',
    enabled: false,
    toolCount: 1,
    created: 'Jul 14, 2026',
  },
];

describe('ToolkitsBrowser', () => {
  it('opens toolkit details from the full identity cell', () => {
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} />);

    const link = screen.getByRole('link', { name: 'Research stack' });
    expect(link).toHaveAttribute('href', '/app/acme/toolkits/research-stack');
    expect(link.parentElement).toHaveClass('p-0');
  });

  it('can open the create form from a market handoff', () => {
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} startCreating />);

    expect(screen.getByLabelText('Toolkit name')).toBeInTheDocument();
  });

  it('opens the toolkit market from its canonical market route', () => {
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} />);

    expect(screen.getByRole('link', { name: 'Browse Market' })).toHaveAttribute(
      'href',
      '/app/acme/market/toolkits',
    );
  });

  it('opens and explicitly closes the labelled create form', async () => {
    const user = userEvent.setup();
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} />);

    const openButton = screen.getByRole('button', { name: 'New Toolkit' });
    expect(openButton).toHaveAttribute('aria-controls', 'toolkit-create-form');
    expect(openButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(openButton);

    const [toggle, formCancel] = screen.getAllByRole('button', { name: 'Cancel' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Toolkit name')).toBeInTheDocument();

    await user.click(formCancel);

    expect(screen.queryByLabelText('Toolkit name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Toolkit' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders translated table labels and a translated no-match state', async () => {
    const user = userEvent.setup();
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} />);

    for (const heading of ['Toolkit', 'Status', 'Tools', 'Created', 'Settings']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search toolkits...'), 'missing');

    expect(screen.getByText('No toolkits match "missing".')).toBeInTheDocument();
  });

  it('gives workspace managers direct, labelled availability controls', () => {
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} canManagePublishing />);

    expect(screen.getByRole('button', { name: 'Publish Research stack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Research stack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Public utilities private' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable Public utilities' })).toBeInTheDocument();
  });
});
