import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ToolkitResourcePicker,
  type ToolkitPickerItem,
} from '@/components/dashboard/toolkits/ToolkitResourcePicker';

const actions = vi.hoisted(() => ({
  addServersToToolkitAction: vi.fn(async () => ({})),
  addSkillsToToolkitAction: vi.fn(async () => ({})),
}));

vi.mock('@/lib/toolkits/actions', () => actions);

const skills: ToolkitPickerItem[] = [
  {
    id: 'skill-a',
    name: 'RouterOS Firewall',
    description: 'Build safe firewall rules',
    source: 'github',
    keywords: ['router', 'network'],
  },
  {
    id: 'skill-b',
    name: 'PDF Reader',
    description: 'Read PDF documents',
    source: 'catalog',
    keywords: ['document'],
  },
  {
    id: 'skill-c',
    name: 'RouterOS Scripts',
    description: 'Write scripts',
    source: 'github',
    keywords: ['automation'],
  },
];

describe('ToolkitResourcePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches, filters, selects visible results, and keeps hidden selections', async () => {
    const user = userEvent.setup();
    render(
      <ToolkitResourcePicker
        kind="skill"
        workspaceSlug="acme"
        toolkitSlug="networking"
        items={skills}
        emptyHref="/app/acme/skills/new"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Filter by source'), 'github');
    expect(screen.getByText('RouterOS Firewall')).toBeInTheDocument();
    expect(screen.getByText('RouterOS Scripts')).toBeInTheDocument();
    expect(screen.queryByText('PDF Reader')).not.toBeInTheDocument();

    const selectVisible = screen.getByRole('checkbox', { name: 'Select all matching (2)' });
    await user.click(screen.getByLabelText('Select RouterOS Firewall'));
    expect(selectVisible).toHaveProperty('indeterminate', true);
    await user.click(selectVisible);
    expect(screen.getByRole('button', { name: 'Add selected (2)' })).toBeEnabled();

    await user.type(screen.getByPlaceholderText('Search available skills...'), 'fireWALL');
    await waitFor(() => expect(screen.queryByText('RouterOS Scripts')).not.toBeInTheDocument());
    expect(screen.getByText('RouterOS Firewall')).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByRole('button', { name: 'Add selected (0)' })).toBeDisabled();
  });

  it('combines source and status filters for MCP candidates', async () => {
    const user = userEvent.setup();
    const mcps: ToolkitPickerItem[] = [
      { id: 'mcp-a', name: 'Catalog Running', description: null, source: 'catalog', status: 'running', keywords: [] },
      { id: 'mcp-b', name: 'Custom Stopped', description: null, source: 'custom', status: 'stopped', keywords: [] },
      { id: 'mcp-c', name: 'Custom Running', description: null, source: 'custom', status: 'running', keywords: [] },
    ];
    render(
      <ToolkitResourcePicker
        kind="mcp"
        workspaceSlug="acme"
        toolkitSlug="ops"
        items={mcps}
        emptyHref="/app/acme/mcp/new"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Filter by source'), 'custom');
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'running');

    expect(screen.getByText('Custom Running')).toBeInTheDocument();
    expect(screen.queryByText('Catalog Running')).not.toBeInTheDocument();
    expect(screen.queryByText('Custom Stopped')).not.toBeInTheDocument();
    expect(screen.getByText('1 matching')).toBeInTheDocument();
  });

  it('does not submit selected resources when Enter is pressed in search', async () => {
    const user = userEvent.setup();
    render(
      <ToolkitResourcePicker
        kind="skill"
        workspaceSlug="acme"
        toolkitSlug="networking"
        items={skills}
        emptyHref="/app/acme/skills/new"
      />,
    );

    await user.click(screen.getByLabelText('Select RouterOS Firewall'));
    await user.type(screen.getByPlaceholderText('Search available skills...'), 'router{enter}');

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(actions.addSkillsToToolkitAction).not.toHaveBeenCalled();
  });

  it('requires narrowing filters before selecting more than the server batch limit', () => {
    const manySkills: ToolkitPickerItem[] = Array.from({ length: 201 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: null,
      source: 'github',
      keywords: [],
    }));

    render(
      <ToolkitResourcePicker
        kind="skill"
        workspaceSlug="acme"
        toolkitSlug="large"
        items={manySkills}
        emptyHref="/app/acme/skills/new"
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Select all matching (201)' })).toBeDisabled();
    expect(
      screen.getByText('Narrow the filters to select all (maximum 200 per batch).'),
    ).toBeInTheDocument();
  });

  it('renders only the first 100 matches while selecting every matching item', async () => {
    const user = userEvent.setup();
    const manySkills: ToolkitPickerItem[] = Array.from({ length: 150 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: null,
      source: 'github',
      keywords: [],
    }));
    const { container } = render(
      <ToolkitResourcePicker
        kind="skill"
        workspaceSlug="acme"
        toolkitSlug="large"
        items={manySkills}
        emptyHref="/app/acme/skills/new"
      />,
    );

    expect(screen.getByText('Showing the first 100 of 150 matching items.')).toBeInTheDocument();
    expect(screen.getByText('Skill 99')).toBeInTheDocument();
    expect(screen.queryByText('Skill 100')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select all matching (150)' }));

    expect(screen.getByText('150 selected')).toBeInTheDocument();
    expect(container.querySelectorAll('input[name="resourceId"]')).toHaveLength(150);
  });
});
