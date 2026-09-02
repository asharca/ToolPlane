import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Alert,
  Badge,
  Button,
  ChatShell,
  Checkbox,
  ConversationSidebar,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  IconButton,
  Input,
  NativeSelect,
  Page,
  Panel,
  Radio,
  SearchInput,
  Tab,
  TabList,
  Textarea,
  type ConversationSidebarGroup,
} from '@toolplane/ui';

const groups: ConversationSidebarGroup[] = [
  {
    id: 'research',
    name: 'Research assistant',
    conversations: [
      { id: 'today', title: 'Today notes', meta: 'meta' },
      { id: 'old', title: 'Old research' },
    ],
  },
  {
    id: 'support',
    name: 'Support assistant',
    conversations: [{ id: 'ticket', title: 'Customer ticket' }],
  },
];

describe('@toolplane/ui', () => {
  it('filters and expands groups while delegating selection and CRUD actions', async () => {
    const user = userEvent.setup();
    const onSelectGroup = vi.fn();
    const onSelectConversation = vi.fn();
    const onCreateGroup = vi.fn();
    const onCreateConversation = vi.fn();
    const onRenameConversation = vi.fn();
    const onDeleteConversation = vi.fn();

    render(
      <ConversationSidebar
        groups={groups}
        activeGroupId="research"
        activeConversationId="today"
        onSelectGroup={onSelectGroup}
        onSelectConversation={onSelectConversation}
        onCreateGroup={onCreateGroup}
        onCreateConversation={onCreateConversation}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
      />,
    );

    expect(screen.getByRole('complementary', { name: 'Assistants' })).toBeInTheDocument();
    expect(screen.getByTitle('Today notes')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('meta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Research assistant' }))
      .toHaveAttribute('aria-current', 'page');

    const researchDisclosure = screen.getByRole('button', {
      name: 'Hide conversations: Research assistant',
    });
    await user.click(researchDisclosure);
    expect(screen.queryByRole('button', { name: 'Today notes' })).not.toBeInTheDocument();
    await user.click(researchDisclosure);
    expect(screen.getByRole('button', { name: 'Today notes' })).toBeInTheDocument();

    const supportDisclosure = screen.getByRole('button', {
      name: 'Hide conversations: Support assistant',
    });
    await user.click(supportDisclosure);
    expect(screen.queryByRole('button', { name: 'Customer ticket' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search assistants and conversations' }), 'customer');
    expect(screen.queryByText('Research assistant')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer ticket' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.queryByRole('button', { name: 'Customer ticket' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New assistant' }));
    await user.click(screen.getByRole('button', { name: 'New conversation: Research assistant' }));
    await user.click(screen.getByRole('button', { name: 'Research assistant' }));
    await user.click(screen.getByRole('button', { name: 'Old research' }));
    await user.click(screen.getByRole('button', { name: 'Rename conversation: Old research' }));
    await user.click(screen.getByRole('button', { name: 'Delete conversation: Old research' }));

    expect(onCreateGroup).toHaveBeenCalledOnce();
    expect(onCreateConversation).toHaveBeenCalledWith(groups[0]);
    expect(onSelectGroup).toHaveBeenCalledWith(groups[0]);
    expect(onSelectConversation).toHaveBeenCalledWith(groups[0].conversations[1], groups[0]);
    expect(onRenameConversation).toHaveBeenCalledWith(groups[0].conversations[1], groups[0]);
    expect(onDeleteConversation).toHaveBeenCalledWith(groups[0].conversations[1], groups[0]);
  });

  it('delegates desktop and mobile shell controls', async () => {
    const user = userEvent.setup();
    const onSidebarOpenChange = vi.fn();
    const onMobilePaneChange = vi.fn();
    const { container } = render(
      <ChatShell
        sidebar={<div>Sidebar</div>}
        header={<div>Header</div>}
        sidebarOpen
        onSidebarOpenChange={onSidebarOpenChange}
        mobilePane="chat"
        onMobilePaneChange={onMobilePaneChange}
      >
        <div>Conversation</div>
      </ChatShell>,
    );

    const shell = container.querySelector('[data-chat-ui="chat-shell"]')!;
    expect(shell).toHaveAttribute('data-sidebar-open', 'true');
    expect(shell).toHaveAttribute('data-mobile-pane', 'chat');

    const sidebar = container.querySelector('.tp-chat-shell__sidebar')!;
    const desktopToggle = container.querySelector<HTMLButtonElement>('.tp-chat-shell__toggle--desktop')!;
    expect(desktopToggle).toHaveAttribute('aria-controls', sidebar.id);
    expect(desktopToggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(desktopToggle);
    expect(onSidebarOpenChange).toHaveBeenCalledWith(false);
    await user.click(container.querySelector<HTMLButtonElement>('.tp-chat-shell__toggle--mobile')!);
    expect(onMobilePaneChange).toHaveBeenCalledWith('sidebar');
    await user.click(container.querySelector<HTMLButtonElement>('.tp-chat-shell__sidebar-mobile-toolbar button')!);
    expect(onMobilePaneChange).toHaveBeenCalledWith('chat');
  });

  it('provides native buttons and inputs without hiding platform behavior', async () => {
    const user = userEvent.setup();
    const buttonRef = createRef<HTMLButtonElement>();
    const inputRef = createRef<HTMLInputElement>();
    const textareaRef = createRef<HTMLTextAreaElement>();
    const onClick = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <>
        <Button ref={buttonRef} variant="primary" size="sm" onClick={onClick}>Save</Button>
        <IconButton icon={<span>+</span>} label="Add item" aria-pressed />
        <Input ref={inputRef} name="title" aria-invalid aria-describedby="title-error" onChange={onChange} />
        <Textarea ref={textareaRef} aria-label="Description" />
        <Checkbox aria-label="Published" />
        <Radio aria-label="Native runtime" name="runtime" />
        <NativeSelect aria-label="Model"><option>GPT</option></NativeSelect>
        <Button asChild variant="ghost"><a href="/settings">Settings</a></Button>
      </>,
    );

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('ui-button-primary', 'ui-button-sm');
    expect(buttonRef.current).toBe(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();

    expect(screen.getByRole('button', { name: 'Add item' })).toHaveAttribute('title', 'Add item');
    expect(screen.getByRole('button', { name: 'Add item' })).toHaveAttribute('aria-pressed', 'true');
    expect(inputRef.current).toHaveAttribute('name', 'title');
    expect(inputRef.current).toHaveAttribute('aria-invalid', 'true');
    expect(inputRef.current).toHaveAttribute('aria-describedby', 'title-error');
    expect(textareaRef.current).toHaveClass('ui-textarea');
    expect(screen.getByRole('checkbox', { name: 'Published' })).toHaveClass('ui-checkbox');
    expect(screen.getByRole('radio', { name: 'Native runtime' })).toHaveClass('ui-radio');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveClass('ui-select-control');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveClass('ui-button-ghost');
    await user.type(inputRef.current!, 'Roadmap');
    expect(onChange).toHaveBeenCalled();

    rerender(<Button loading loadingLabel="Saving">Save</Button>);
    expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving' })).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps search state in the host and delegates clearing', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    function SearchHarness() {
      const [value, setValue] = useState('');
      return (
        <SearchInput
          value={value}
          label="Search projects"
          clearLabel="Clear projects"
          placeholder="Search"
          onChange={(event) => setValue(event.target.value)}
          onClear={() => {
            setValue('');
            onClear();
          }}
        />
      );
    }

    render(<SearchHarness />);
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    await user.type(search, 'toolplane');
    expect(search).toHaveValue('toolplane');
    const clear = screen.getByRole('button', { name: 'Clear projects' });
    expect(clear).toHaveAttribute('type', 'button');
    await user.click(clear);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Clear projects' })).not.toBeInTheDocument();
  });

  it('provides reusable layout, navigation, feedback, and accessible table primitives', () => {
    render(
      <Page as="div">
        <Panel title="Runtime" description="Deployment settings" actions={<Button>Edit</Button>}>
          <Badge tone="success">Running</Badge>
          <Alert tone="warning">Restart required</Alert>
          <TabList label="Runtime sections">
            <Tab current>Overview</Tab>
            <Tab>Logs</Tab>
          </TabList>
          <DataTable label="Deployments" headers={[{ label: 'Name' }, { label: 'Status' }]}>
            <tr><td>Weather</td><td>Running</td></tr>
          </DataTable>
        </Panel>
      </Page>,
    );

    expect(screen.getByText('Runtime').closest('[data-toolplane-ui="panel"]')).toBeInTheDocument();
    expect(screen.getByText('Running', { selector: '[data-toolplane-ui="badge"]' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Restart required');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Deployments' })).toHaveAttribute('tabindex', '0');
    for (const header of screen.getAllByRole('columnheader')) expect(header).toHaveAttribute('scope', 'col');
  });

  it('keeps dialog focus management and dismissal in the package', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <Dialog defaultOpen onOpenChange={onOpenChange}>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>Delete deployment</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogContent>
        </DialogPortal>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete deployment' })).toHaveAccessibleDescription('This cannot be undone.');
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps package source independent from ToolPlane and Next.js', () => {
    const sourceRoot = resolve(process.cwd(), 'packages/ui/src');
    const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['next/', 'next-intl', '@/', '/api/v1']) {
        expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
