// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAgentChannelRunner, stopAgentChannelRunner, liveAgentChannelStatus, reconcileAgentChannelRunners } from '@/lib/agents/channel-runtime';
import { getAgentChannelLogs } from '@/lib/agents/channel-runtime-logs';

const mocks = vi.hoisted(() => ({ create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), sandbox: vi.fn(), run: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/lib/db', () => ({ db: { agentChannelConnection: mocks } }));
vi.mock('@/lib/agents/channels/create-adapter', () => ({ createChannelAdapter: mocks.create }));
vi.mock('@/lib/agents/channel-sandboxes', () => ({ getChannelSandbox: mocks.sandbox }));
vi.mock('@/lib/agents/message-service', () => ({ runAgentChannelMessage: mocks.run }));
vi.mock('@/lib/agents/channel-connections', () => ({ decryptChannelCredentials: () => ({ WEIXIN_TOKEN: 'bot-secret', WEIXIN_ACCOUNT_ID: 'bot', WEIXIN_ALLOWED_USERS: 'sender' }) }));

function adapter() {
  return Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}), sendTypingIndicator: vi.fn(async () => {}),
  });
}
const event = { chatId: 'sender', userId: 'sender', userName: 'User', text: 'Hello', messageId: '1' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOOLPLANE_HERMES_ROOT', '');
  vi.stubEnv('HERMES_ROOT', '');
  globalThis.__toolplaneAgentChannelAdapters = undefined;
  globalThis.__toolplaneAgentChannelStarts = undefined;
  globalThis.__toolplaneAgentChannelLogs = undefined;
  mocks.findFirst.mockResolvedValue({ id: 'connection', workspaceId: 'workspace', sandboxId: 'sandbox', agentId: 'agent', platform: 'weixin', credentials: {} });
  mocks.sandbox.mockResolvedValue({ id: 'sandbox', agentId: 'agent' });
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.run.mockResolvedValue({ status: 200, body: { delivery: 'message', message: 'Reply' } });
});
afterEach(async () => {
  for (const id of globalThis.__toolplaneAgentChannelAdapters?.keys() ?? []) await stopAgentChannelRunner('workspace', id);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('native channel lifecycle', () => {
  it('restores active channels without spawning Hermes or Python', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'missing', workspaceId: 'workspace', platform: 'weixin' },
      { id: 'connection', workspaceId: 'workspace', platform: 'weixin' },
      { id: 'callback', workspaceId: 'workspace', platform: 'whatsapp' },
    ]);
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue(adapter());
    expect(await reconcileAgentChannelRunners()).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(liveAgentChannelStatus('connection')).toBe('starting');
  });

  it('deduplicates starts, redacts secrets, and ignores stale events after stop', async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    await Promise.all([startAgentChannelRunner('workspace', 'connection'), startAgentChannelRunner('workspace', 'connection')]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    transport.emit('statusChange', { connected: true });
    expect(liveAgentChannelStatus('connection')).toBe('running');
    transport.emit('log', { level: 'error', message: 'bad bot-secret' });
    expect(getAgentChannelLogs('connection').at(-1)?.message).toBe('bad [REDACTED]');
    transport.emit('message', { ...event, userId: 'unauthorized' });
    expect(mocks.run).not.toHaveBeenCalled();
    transport.emit('message', event);
    await vi.waitFor(() => expect(transport.sendMessage).toHaveBeenCalledWith('sender', 'Reply', expect.any(Object)));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent', sandboxId: 'sandbox', workspaceId: 'workspace' }));
    const signal = mocks.run.mock.calls[0][0].signal as AbortSignal;
    await stopAgentChannelRunner('workspace', 'connection');
    expect(signal.aborted).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledOnce();
    const updates = mocks.updateMany.mock.calls.length;
    transport.emit('statusChange', { connected: true });
    transport.emit('message', event);
    expect(liveAgentChannelStatus('connection')).toBe('stopped');
    expect(mocks.updateMany).toHaveBeenCalledTimes(updates);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('does not deliver the old turn after moving or stopping the channel', async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    let complete!: (value: unknown) => void;
    mocks.run.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    await startAgentChannelRunner('workspace', 'connection');
    transport.emit('message', event);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    await stopAgentChannelRunner('workspace', 'connection');
    complete({ status: 200, body: { delivery: 'message', message: 'Old reply' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects missing sandbox assignments and cleans up a failed connection', async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    expect(await startAgentChannelRunner('other', 'connection')).toMatchObject({ error: expect.any(String) });
    mocks.sandbox.mockResolvedValueOnce({ id: 'sandbox', agentId: null });
    expect(await startAgentChannelRunner('workspace', 'connection')).toMatchObject({ error: expect.stringContaining('Assign') });
    expect(mocks.create).not.toHaveBeenCalled();
    const transport = adapter();
    transport.connect.mockRejectedValueOnce(new Error('Invalid bot-secret'));
    mocks.create.mockResolvedValue(transport);
    expect(await startAgentChannelRunner('workspace', 'connection')).toEqual({ error: 'Invalid [REDACTED]' });
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(liveAgentChannelStatus('connection')).toBe('stopped');
  });
});
