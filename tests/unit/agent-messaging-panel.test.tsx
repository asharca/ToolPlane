import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMessagingPanel } from '@/components/dashboard/agents/AgentMessagingPanel';
import type { AgentChannelConnectionClientView as Channel } from '@/lib/agents/channel-connection-client';

afterEach(() => vi.unstubAllGlobals());

describe('channel settings', () => {
  it('scopes channels to the sandbox and migrates without sending credentials', async () => {
    const channel: Channel = {
      id: 'channel', agentId: 'agent-a', sandboxId: 'sandbox-a', platform: 'feishu', platformLabel: 'Feishu', name: 'Scoped bot',
      status: 'stopped', connectionMode: 'WebSocket', credentialNames: ['FEISHU_APP_SECRET'], credentialValues: {},
      missingStartCredentialNames: [], pairing: null, lastError: null,
    };
    let channels = [channel, { ...channel, id: 'other', name: 'Other sandbox bot', sandboxId: 'sandbox-b', agentId: 'agent-b' }];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const command = JSON.parse(String(init.body));
        if (command.action === 'move') channels = channels.map((item) => item.id === command.connectionId ? { ...item, sandboxId: command.sandboxId, agentId: 'agent-b' } : item);
      }
      return Response.json({ connections: channels, agents: [{ id: 'agent-a', name: 'Agent A' }], sandboxes: [
        { id: 'sandbox-a', name: 'Sandbox A', agentId: 'agent-a', agentName: 'Agent A' },
        { id: 'sandbox-b', name: 'Sandbox B', agentId: 'agent-b', agentName: 'Agent B' },
      ] });
    });
    vi.stubGlobal('fetch', fetch);
    render(<AgentMessagingPanel slug="acme" sandboxId="sandbox-a" connections={channels} />);
    expect(screen.getByText('Scoped bot')).toBeInTheDocument();
    expect(screen.queryByText('Other sandbox bot')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Bind agent')).toBeDisabled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Migrate' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Sandbox B / Agent B' });
    fireEvent.change(within(dialog).getByLabelText('Target sandbox'), { target: { value: 'sandbox-b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Scoped bot')).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('?sandboxId=sandbox-a'))).toBe(true);
    const request = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(request[1]!.body))).toEqual({ action: 'move', connectionId: 'channel', sandboxId: 'sandbox-b' });
  });

  it('has all reference platforms, creates and edits a channel, and confirms deletion', async () => {
    let channels: Channel[] = [];
    const agents = [{ id: 'agent', name: 'Support agent' }];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ connections: channels, agents });
      const command = JSON.parse(String(init.body));
      if (command.action === 'create') channels = [{
        id: 'channel', agentId: null, sandboxId: null, platform: 'telegram', platformLabel: 'Telegram', name: command.name,
        status: 'setup_required', connectionMode: 'hosted', credentialNames: [], credentialValues: {},
        missingStartCredentialNames: ['TELEGRAM_BOT_TOKEN'], pairing: null, lastError: null,
      }];
      if (command.action === 'update') channels = channels.map((channel) => ({
        ...channel, name: command.name ?? channel.name,
        agentId: command.agentId === undefined ? channel.agentId : command.agentId,
      }));
      if (command.action === 'delete') channels = [];
      return Response.json({ connections: channels, connectionId: 'channel' });
    });
    vi.stubGlobal('fetch', fetch);
    render(<AgentMessagingPanel slug="acme" connections={[]} />);
    for (const name of ['Feishu', 'Telegram', 'QQ', 'WeChat', 'Discord', 'Slack']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Telegram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Support agent' })).toBeInTheDocument());
    expect(within(dialog).getByText('Channel commands')).toBeInTheDocument();
    for (const command of ['/new', '/compact', '/help', '/whoami']) expect(within(dialog).getByText(command, { exact: true })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Connection name'), { target: { value: 'Telegram support' } });
    fireEvent.change(within(dialog).getByLabelText('Bind agent'), { target: { value: 'agent' } });
    fireEvent.change(within(dialog).getByLabelText('Bot Token'), { target: { value: 'new-secret' } });
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save credentials' }).closest('form')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Telegram support')).toBeInTheDocument();
    expect(screen.getByText(/Support agent/)).toBeInTheDocument();
    const updates = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)));
    expect(updates).toContainEqual(expect.objectContaining({ action: 'update', name: 'Telegram support', agentId: 'agent', credentials: { TELEGRAM_BOT_TOKEN: 'new-secret' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmation = await screen.findByRole('dialog');
    expect(within(confirmation).getByText(/Existing conversations are kept/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('No Telegram channels')).toBeInTheDocument();
  });

  it('keeps the editor open and surfaces failed saves', async () => {
    const channel: Channel = {
      id: 'channel', agentId: null, sandboxId: null, platform: 'feishu', platformLabel: 'Feishu', name: 'Feishu bot',
      status: 'setup_required', connectionMode: 'WebSocket', credentialNames: [], credentialValues: {},
      missingStartCredentialNames: [], pairing: null, lastError: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ error: 'Cannot save channel' }, { status: 400 })
      : Response.json({ connections: [channel], agents: [] })));
    render(<AgentMessagingPanel slug="acme" connections={[channel]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save credentials' }).closest('form')!);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cannot save channel');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('allows Telegram reauthentication and clears saved secret drafts', async () => {
    const channel: Channel = {
      id: 'channel', agentId: null, sandboxId: null, platform: 'telegram', platformLabel: 'Telegram', name: 'Telegram bot',
      status: 'stopped', connectionMode: 'hosted', credentialNames: ['TELEGRAM_BOT_TOKEN'], credentialValues: {},
      missingStartCredentialNames: [], pairing: { provider: 'telegram_managed_bot', status: 'ready', extra: { ownerUserId: '42' } }, lastError: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ connections: [channel], agents: [] })));
    render(<AgentMessagingPanel slug="acme" connections={[channel]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Telegram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save Telegram setup' })).toBeInTheDocument();
    const token = within(dialog).getByLabelText('Bot Token');
    fireEvent.change(token, { target: { value: 'replacement-secret' } });
    fireEvent.blur(token);
    await waitFor(() => expect(token).toHaveValue(''));
    expect(token).toHaveAttribute('placeholder', 'Saved. Leave blank to keep unchanged');
  });
});
