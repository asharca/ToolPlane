import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolkitsBrowser, type ToolkitRow } from '@/components/dashboard/ToolkitsBrowser';

vi.mock('@/lib/toolkits/actions', () => ({ createToolkitAction: vi.fn() }));

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
});
