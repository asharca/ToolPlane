import { useState, type FormEventHandler } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Server } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from '@/components/dashboard/agents/AgentResourceSelect';

const resources: AgentResourceOption[] = [
  {
    id: 'catalog-running',
    label: 'Catalog Router',
    description: 'Routes catalog traffic',
    source: 'catalog',
    status: 'running',
    keywords: ['network'],
  },
  {
    id: 'custom-stopped',
    label: 'Custom Router',
    description: 'Routes custom traffic',
    source: 'custom',
    status: 'stopped',
    keywords: ['network'],
  },
  {
    id: 'custom-running',
    label: 'Custom Logs',
    description: 'Collects runtime logs',
    source: 'custom',
    status: 'running',
    keywords: ['observability'],
  },
];

function ResourceSelectHarness({
  options = resources,
  initialSelectedIds = [],
  onFormChange,
  onSubmit,
}: {
  options?: AgentResourceOption[];
  initialSelectedIds?: string[];
  onFormChange?: FormEventHandler<HTMLFormElement>;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialSelectedIds));

  return (
    <form
      onChange={onFormChange}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
    >
      <AgentResourceSelect
        icon={Server}
        label="MCP"
        name="deploymentId"
        options={options}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />
    </form>
  );
}

function selectedFormIds(container: HTMLElement): string[] {
  const form = container.querySelector('form');
  if (!form) throw new Error('Expected resource select form.');
  return new FormData(form).getAll('deploymentId').map(String);
}

describe('AgentResourceSelect', () => {
  it('combines search, source, and status filters with AND semantics', async () => {
    const user = userEvent.setup();
    render(<ResourceSelectHarness />);

    await user.selectOptions(screen.getByLabelText('MCP: Filter by source'), 'custom');
    await user.selectOptions(screen.getByLabelText('MCP: Filter by status'), 'running');
    await user.type(screen.getByLabelText('Search MCP...'), 'observability');

    await waitFor(() => {
      expect(screen.getByText('Custom Logs')).toBeInTheDocument();
      expect(screen.queryByText('Catalog Router')).not.toBeInTheDocument();
      expect(screen.queryByText('Custom Router')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('checkbox', { name: 'Select all matching (1)' })).toBeEnabled();
  });

  it('selects every match while preserving filtered-out selections and hidden inputs', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ResourceSelectHarness initialSelectedIds={['catalog-running']} />,
    );

    await user.selectOptions(screen.getByLabelText('MCP: Filter by source'), 'custom');
    await user.selectOptions(screen.getByLabelText('MCP: Filter by status'), 'running');
    await user.click(screen.getByRole('checkbox', { name: 'Select all matching (1)' }));

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(new Set(selectedFormIds(container))).toEqual(
      new Set(['catalog-running', 'custom-running']),
    );
    expect(container.querySelectorAll('input[name="deploymentId"][type="hidden"]')).toHaveLength(2);
  });

  it('marks a partial selection as indeterminate and can clear every selection', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ResourceSelectHarness initialSelectedIds={['catalog-running']} />,
    );

    const selectMatches = screen.getByRole('checkbox', { name: 'Select all matching (3)' });
    expect(selectMatches).not.toBeChecked();
    expect(selectMatches).toHaveProperty('indeterminate', true);

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(screen.getByText('0 selected')).toBeInTheDocument();
    expect(selectedFormIds(container)).toEqual([]);
    expect(selectMatches).toHaveProperty('indeterminate', false);
  });

  it('keeps search and filter controls from changing or submitting the parent form', async () => {
    const user = userEvent.setup();
    const onFormChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ResourceSelectHarness onFormChange={onFormChange} onSubmit={onSubmit} />,
    );

    const search = screen.getByLabelText('Search MCP...');
    await user.type(search, 'router');
    await user.selectOptions(screen.getByLabelText('MCP: Filter by source'), 'custom');
    await user.selectOptions(screen.getByLabelText('MCP: Filter by status'), 'stopped');
    await user.type(search, '{enter}');

    expect(onFormChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders only 100 rows but selects all matches in a larger result set', async () => {
    const user = userEvent.setup();
    const options: AgentResourceOption[] = Array.from({ length: 125 }, (_, index) => ({
      id: `mcp-${index}`,
      label: `MCP ${index}`,
      source: 'catalog',
      status: 'running',
    }));
    const { container } = render(<ResourceSelectHarness options={options} />);

    expect(
      screen.getByText(
        'Showing the first 100 of 125 matches. Narrow the search or filters to find a specific resource.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('MCP 99')).toBeInTheDocument();
    expect(screen.queryByText('MCP 100')).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[aria-label^="Select MCP "]')).toHaveLength(100);

    await user.click(screen.getByRole('checkbox', { name: 'Select all matching (125)' }));

    expect(screen.getByText('125 selected')).toBeInTheDocument();
    expect(selectedFormIds(container)).toHaveLength(125);
    expect(container.querySelectorAll('input[name="deploymentId"][type="hidden"]')).toHaveLength(125);
  });
});
