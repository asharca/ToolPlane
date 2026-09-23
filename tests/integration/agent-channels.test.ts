// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Task, TaskState } from '@a2a-js/sdk';
import { runNativeEntry } from '@/lib/a2a/ingress';
import { claimTask, finishTask, getTask } from '@/lib/a2a/store';
import { textArtifact } from '@/lib/a2a/model';
import { db } from '@/lib/db';
import { GET, POST } from '@/app/api/v1/workspaces/[slug]/agent-channels/route';
import { createAgentChannelConnection, decryptChannelCredentials } from '@/lib/agents/channel-connections';
import { runAgentChannelMessage } from '@/lib/agents/message-service';
import { liveAgentChannelStatus, startAgentChannelRunner, stopAgentChannelRunner } from '@/lib/agents/channel-runtime';
import { runDedicatedSandboxTurn } from '@/lib/agents/sandbox-turn';
import { runNativeAgent } from '@/lib/agents/native';
import { acquireConversationOperation, operateConversation } from '@/lib/agents/conversation-operations';
import { activeConversationMessages } from '@/lib/agents/conversation-context';
import { POST as conversationOperation } from '@/app/api/v1/agents/[agentId]/conversations/[conversationId]/operations/route';
import { POST as runtimeCommand } from '@/app/api/v1/agents/[agentId]/conversations/[conversationId]/commands/route';
import { executeRuntimeCommand } from '@/lib/agents/runtime-command-service';
import { RUNTIME_COMMANDS_PART, RUNTIME_USAGE_PART } from '@/lib/agents/runtime-commands';
import { kickWorkCoordinator } from '@/lib/work/coordinator';

const identity = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('@/lib/auth/request-user', () => ({ resolveAccountRequestUser: async () => identity.user, resolveRequestUser: async () => identity.user }));
vi.mock('@/lib/agents/channel-runtime', () => ({
  liveAgentChannelStatus: vi.fn(() => 'stopped'),
  startAgentChannelRunner: vi.fn(async () => ({ error: 'Runner is not configured' })),
  stopAgentChannelRunner: vi.fn(async () => {}),
}));
vi.mock('@/lib/agents/native', () => ({ uiMessagesToPi: (value: unknown) => value, runNativeAgent: vi.fn(async () => 'Channel reply') }));
vi.mock('@/lib/agents/run', () => ({ buildAgentToolSet: async () => ({}) }));
vi.mock('@/lib/agents/sandbox-turn', () => ({ runDedicatedSandboxTurn: vi.fn(async () => 'Channel reply') }));
vi.mock('@/lib/work/coordinator', () => ({ kickWorkCoordinator: vi.fn() }));
// Keep real task admission, policy, persistence and receipts. Only replace the
// model/CLI wait with a deterministic execution result; no legacy turn executes.
vi.mock('@/lib/a2a/ingress', async (original) => {
  const actual = await original<typeof import('@/lib/a2a/ingress')>();
  return { ...actual, runNativeEntry: vi.fn(async (input: Parameters<typeof actual.runNativeEntry>[0]) => {
    const accepted = await actual.submitNativeEntry(input, () => {});
    const path = `/app/channels/work?mode=a2a&agent=${input.agentId}&task=${accepted.row.id}`;
    await input.onAccepted?.(Task.fromJSON(accepted.row.snapshot), path);
    if (!accepted.replay) {
      const running = await claimTask(accepted.row.id);
      if (!running?.leaseToken) throw new Error('Native fixture task was not claimed.');
      await finishTask(running.id, running.leaseToken, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('Channel reply'));
    }
    return { task: await getTask(accepted.grant, accepted.row.id), path };
  }) };
});

let workspace: { id: string; slug: string };
let other: { id: string; slug: string };
let agentId: string;
let foreignAgentId: string;
let providerId: string;
beforeAll(async () => {
  const user = await db.user.create({ data: { email: `channel-ui-${Date.now()}@test.dev`, passwordHash: 'unused' } });
  identity.user = user;
  workspace = await db.workspace.create({ data: { slug: `channel-ui-${Date.now()}`, name: 'Channels', ownerId: user.id } });
  other = await db.workspace.create({ data: { slug: `channel-other-${Date.now()}`, name: 'Other', ownerId: user.id } });
  const provider = await db.modelProvider.create({ data: { workspaceId: workspace.id, name: 'Test', format: 'openai', baseUrl: 'https://example.invalid', apiKey: 'unused', models: ['test'] } });
  providerId = provider.id;
  agentId = (await db.agent.create({ data: { workspaceId: workspace.id, name: 'Bound agent', slug: 'bound-agent', runtimeKind: 'pi', providerId: provider.id, model: 'test' } })).id;
  foreignAgentId = (await db.agent.create({ data: { workspaceId: other.id, name: 'Other agent', slug: 'other-agent', runtimeKind: 'pi' } })).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(liveAgentChannelStatus).mockReturnValue('stopped');
  vi.mocked(startAgentChannelRunner).mockResolvedValue({ error: 'Runner is not configured' });
  vi.mocked(runNativeAgent).mockResolvedValue('Channel reply');
});
afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
  await db.user.delete({ where: { id: identity.user!.id } });
  await db.$disconnect();
});
async function command(body: Record<string, unknown>, slug = workspace.slug) {
  return POST(new Request(`http://localhost/api/v1/workspaces/${slug}/agent-channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug }) });
}
async function createSandbox(workspaceId: string, name: string) {
  const deployment = await db.deployment.create({ data: { workspaceId, name, status: 'stopped' } });
  return db.sandbox.create({ data: { workspaceId, deploymentId: deployment.id, name, slug: name.toLowerCase().replaceAll(' ', '-'), kind: 'docker', network: 'isolated' } });
}

async function enableNativeAgent(id: string, sandboxId?: string) {
  if (!sandboxId) {
    const sandbox = await createSandbox(workspace.id, `Native ${id}`);
    await db.agentSandbox.create({ data: { agentId: id, sandboxId: sandbox.id, isDefault: true } });
  }
  await db.agent.update({ where: { id }, data: { a2aInternalEnabled: true } });
}
async function nativeBinding(conversationId: string) {
  return db.a2AEntryBinding.findFirstOrThrow({ where: { kind: 'channel', sourceId: conversationId }, include: { lastTask: true, context: true } });
}

describe('workspace channels', () => {
  it('dispatches scoped Claude commands to the native session, preserves history, and queues registered native commands', async () => {
    const agent = await db.agent.create({ data: { workspaceId: workspace.id, slug: 'claude-commands', name: 'Claude commands', runtimeKind: 'claude-code', providerId, model: 'test' } });
    const conversation = await db.conversation.create({ data: { agentId: agent.id } });
    await db.message.createMany({ data: [
      { conversationId: conversation.id, role: 'user', parts: [{ type: 'text', text: 'Keep plan.md' }] },
      { conversationId: conversation.id, role: 'assistant', parts: [{ type: 'text', text: 'Measured reply' }, { type: RUNTIME_USAGE_PART, data: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.03 } }] },
      { conversationId: conversation.id, role: 'assistant', parts: [{ type: 'text', text: 'Historical unmeasured reply' }] },
    ] });
    const run = (line: string, id = conversation.id, extra = {}) => runtimeCommand(new Request('http://localhost/commands', { method: 'POST', body: JSON.stringify({ line, ...extra }) }), { params: Promise.resolve({ agentId: agent.id, conversationId: id }) });
    const runtimeCalls = vi.mocked(runDedicatedSandboxTurn).mock.calls.length;
    expect(await (await run('/usage')).json()).toEqual({ kind: 'output', text: 'Channel reply' });
    expect(runDedicatedSandboxTurn).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/usage', runtimeSessionId: conversation.id }));
    expect(await (await run('/context')).json()).toEqual({ kind: 'output', text: 'Channel reply' });
    expect(runDedicatedSandboxTurn).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/context', runtimeSessionId: conversation.id }));
    expect((await run('/goal something')).status).toBe(400);
    expect(vi.mocked(runDedicatedSandboxTurn).mock.calls).toHaveLength(runtimeCalls + 2);
    expect((await run('/usage', 'missing')).status).toBe(404);
    expect((await run('/usage', conversation.id, { workspaceId: other.id })).status).toBe(400);
    await expect(executeRuntimeCommand({ workspaceId: other.id, agentId: agent.id, conversationId: conversation.id, line: '/clear' })).rejects.toMatchObject({ status: 404 });
    const release = acquireConversationOperation(conversation.id)!;
    expect((await run('/clear')).status).toBe(409);
    release();
    expect(await (await run('/clear')).json()).toEqual({ kind: 'output', text: 'Channel reply' });
    expect(runDedicatedSandboxTurn).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/clear', runtimeSessionId: conversation.id }));
    const history = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(history).toHaveLength(6);
    expect(history.slice(-3).every((message) => message.role === 'assistant' && Array.isArray(message.parts) && message.parts.some((part) => part && typeof part === 'object' && 'type' in part && part.type === 'text'))).toBe(true);
    expect(activeConversationMessages(history)).toEqual([]);
    expect(await (await run('/context')).json()).toEqual({ kind: 'output', text: 'Channel reply' });
    expect(runDedicatedSandboxTurn).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/context', messages: [] }));
    vi.mocked(runDedicatedSandboxTurn).mockRejectedValueOnce(new Error('Native context is unavailable.'));
    const failed = await run('/context');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Native context is unavailable.' });
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(7);
    const work = await db.workSession.create({ data: { workspaceId: workspace.id, agentId: agent.id, conversationId: conversation.id, runtimeKind: 'claude-code', task: 'Test', status: 'running' } });
    expect((await run('/clear')).status).toBe(409);
    await db.workSession.update({ where: { id: work.id }, data: { status: 'completed' } });
    expect(await (await run('/usage')).json()).toEqual({ kind: 'queued', workSessionId: work.id });
    await db.workSession.update({ where: { id: work.id }, data: { status: 'completed' } });
    await db.message.create({ data: { conversationId: conversation.id, role: 'assistant', parts: [{ type: RUNTIME_COMMANDS_PART, data: { runtimeKind: 'claude-code', commands: [{ name: 'plugin:review' }] } }] } });
    expect(await (await run('/plugin:review src')).json()).toEqual({ kind: 'queued', workSessionId: work.id });
    expect(await db.workSession.findUnique({ where: { id: work.id } })).toMatchObject({ status: 'queued' });
    expect(kickWorkCoordinator).toHaveBeenCalled();
    await db.workSession.update({ where: { id: work.id }, data: { status: 'completed' } });
  });

  it('does not advertise or dispatch legacy commands from native A2A channels', async () => {
    const agent = await db.agent.create({ data: { workspaceId: workspace.id, slug: 'dsh-commands', name: 'DSH commands', runtimeKind: 'dsh', providerId, model: 'test' } });
    await enableNativeAgent(agent.id);
    const channel = (await createAgentChannelConnection({ workspaceId: workspace.id, agentId: agent.id, platform: 'weixin', name: 'DSH commands', credentials: {} })).connection!;
    await db.agentChannelConnection.update({ where: { id: channel.id }, data: { status: 'running', a2aActorId: identity.user!.id } });
    const run = (message: string) => runAgentChannelMessage({ workspaceId: workspace.id, connectionId: channel.id, agentId: agent.id,
      rawBody: { message, source: { chatId: 'commands-user', userId: 'commands-user', messageId: randomUUID() } } });
    const first = await run('Hello');
    expect(first.status).toBe(200);
    const id = (first.body as { conversationId: string }).conversationId;
    const binding = await nativeBinding(id);
    const legacyCalls = vi.mocked(runDedicatedSandboxTurn).mock.calls.length;
    const nativeCalls = vi.mocked(runNativeEntry).mock.calls.length;
    const help = await run('/help');
    expect(help.body).toMatchObject({ message: expect.stringContaining('/new') });
    expect(help.body).toMatchObject({ message: expect.stringContaining('/whoami') });
    expect(help.body).not.toMatchObject({ message: expect.stringContaining('/goal') });
    for (const line of ['/plan', '/goal pause', '/goal Finish the checklist', '/compact']) {
      expect((await run(line)).body).toMatchObject({ message: expect.stringContaining('native workbench') });
    }
    expect(vi.mocked(runDedicatedSandboxTurn).mock.calls).toHaveLength(legacyCalls);
    expect(vi.mocked(runNativeEntry).mock.calls).toHaveLength(nativeCalls);
    expect((await nativeBinding(id)).lastTaskId).toBe(binding.lastTaskId);
    expect(await db.message.count({ where: { conversationId: id } })).toBe(2);
  });

  it('preserves native channel history, refuses legacy compaction and starts a new A2A context on /new', async () => {
    const agent = await db.agent.create({ data: { workspaceId: workspace.id, slug: `compact-${Date.now()}`, name: 'DSH compaction', runtimeKind: 'dsh', providerId, model: 'test' } });
    await enableNativeAgent(agent.id);
    const channel = (await createAgentChannelConnection({ workspaceId: workspace.id, agentId: agent.id, platform: 'weixin', name: 'Compact test', credentials: {} })).connection!;
    await db.agentChannelConnection.update({ where: { id: channel.id }, data: { status: 'running', a2aActorId: identity.user!.id } });
    const run = (message: string) => runAgentChannelMessage({ workspaceId: workspace.id, connectionId: channel.id, agentId: agent.id,
      rawBody: { message, source: { chatId: 'compact-user', userId: 'compact-user', messageId: randomUUID() } } });
    const legacyCalls = vi.mocked(runDedicatedSandboxTurn).mock.calls.length;
    const first = await run('Old detailed requirements. '.repeat(500));
    if (first.status !== 200 || !('conversationId' in first.body)) throw new Error('Missing conversation');
    const id = first.body.conversationId;
    const initial = await nativeBinding(id);
    await run('Keep this latest exchange exactly.');
    const before = await db.message.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect((await run('/compact')).body).toMatchObject({ conversationId: id, message: expect.stringContaining('native workbench') });
    expect(await db.message.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).toEqual(before);
    await run('Continue without replaying history');
    const continued = await nativeBinding(id);
    expect(continued.contextId).toBe(initial.contextId);
    expect(continued.lastTaskId).not.toBe(initial.lastTaskId);
    const count = await db.message.count({ where: { conversationId: id } });
    const reset = await run('/new');
    expect(reset.body).toMatchObject({ conversationId: expect.not.stringMatching(id) });
    const next = await run('Only the new conversation');
    if (next.status !== 200 || !('conversationId' in next.body)) throw new Error('Missing new conversation');
    const fresh = await nativeBinding(next.body.conversationId);
    expect(fresh.contextId).not.toBe(initial.contextId);
    const history = Task.fromJSON(fresh.lastTask!.snapshot).history;
    expect(history.filter((message) => message.role === 1)).toHaveLength(1);
    expect(JSON.stringify(history)).toContain('Only the new conversation');
    expect(JSON.stringify(history)).not.toContain('Old detailed requirements');
    expect(await db.message.count({ where: { conversationId: id } })).toBe(count);
    expect(vi.mocked(runDedicatedSandboxTurn).mock.calls).toHaveLength(legacyCalls);
  });

  it('requires explicit channel authority and stable message IDs, and deduplicates accepted native tasks', async () => {
    const agent = await db.agent.create({ data: { workspaceId: workspace.id, slug: 'channel-authority', name: 'Channel authority', runtimeKind: 'dsh', providerId, model: 'test' } });
    await enableNativeAgent(agent.id);
    const channel = (await createAgentChannelConnection({ workspaceId: workspace.id, agentId: agent.id, platform: 'weixin', name: 'Authority', credentials: {} })).connection!;
    await db.agentChannelConnection.update({ where: { id: channel.id }, data: { status: 'running' } });
    const messageId = randomUUID();
    const run = (message = 'Authorized task', id: string | undefined = messageId) => runAgentChannelMessage({
      workspaceId: workspace.id, connectionId: channel.id, agentId: agent.id,
      rawBody: { message, source: { chatId: 'authority-chat', userId: 'external-user-not-a-platform-account', messageId: id } },
    });
    expect((await run()).status).toBe(409);
    expect(await db.a2ATask.count({ where: { context: { agentId: agent.id } } })).toBe(0);
    await db.agentChannelConnection.update({ where: { id: channel.id }, data: { a2aActorId: identity.user!.id } });
    expect((await runAgentChannelMessage({ workspaceId: workspace.id, connectionId: channel.id, agentId: agent.id,
      rawBody: { message: 'No ID', source: { chatId: 'authority-chat', userId: 'external-user-not-a-platform-account' } } })).status).toBe(400);
    const first = await run(); expect(first.status).toBe(200);
    const replay = await run(); expect(replay.body).toMatchObject({ message: 'Channel reply' });
    expect(await db.a2ATask.count({ where: { context: { agentId: agent.id } } })).toBe(1);
    const binding = await nativeBinding((first.body as { conversationId: string }).conversationId);
    expect(binding.lastTask.grant).toMatchObject({ actorId: identity.user!.id });
    await expect(run('Changed content')).rejects.toThrow('reused with different content');
    await db.agentChannelConnection.update({ where: { id: channel.id }, data: { a2aActorId: null } });
    expect((await run('After revocation', randomUUID())).status).toBe(409);
    expect(await db.a2ATask.count({ where: { context: { agentId: agent.id } } })).toBe(1);
  });

  it('keeps compaction scoped, rejects busy conversations, and leaves history unchanged on model failure', async () => {
    const conversation = await db.conversation.create({ data: { agentId, messages: { create: [
      { role: 'user', parts: [{ type: 'text', text: 'Details '.repeat(1000) }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'The current plan.' }] },
    ] } } });
    const operate = () => operateConversation({ workspaceId: workspace.id, agentId, conversationId: conversation.id, action: 'compact' });
    await expect(operateConversation({ workspaceId: other.id, agentId, conversationId: conversation.id, action: 'compact' })).rejects.toMatchObject({ code: 'notFound' });
    const release = acquireConversationOperation(conversation.id)!;
    await expect(operate()).rejects.toMatchObject({ code: 'busy' });
    release();
    vi.mocked(runNativeAgent).mockRejectedValueOnce(new Error('Summary unavailable'));
    await expect(operate()).rejects.toThrow('Summary unavailable');
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(2);
    expect(await operate()).toMatchObject({ compacted: true });
    const foreign = await conversationOperation(new Request('http://localhost/operations', { method: 'POST', body: JSON.stringify({ action: 'compact' }) }),
      { params: Promise.resolve({ agentId: foreignAgentId, conversationId: conversation.id }) });
    expect(foreign.status).toBe(404);
  });

  it('isolates sandbox configuration, migrates credentials, and routes DSH turns to the target sandbox', async () => {
    const sandboxes = await Promise.all(['Source', 'Target'].map(async (name) => {
      const sandbox = await createSandbox(workspace.id, name);
      const agent = await db.agent.create({ data: { workspaceId: workspace.id, name, slug: name.toLowerCase(), runtimeKind: 'dsh', providerId, model: 'test' } });
      await db.agentSandbox.create({ data: { agentId: agent.id, sandboxId: sandbox.id, isDefault: true } });
      await enableNativeAgent(agent.id, sandbox.id);
      return { ...sandbox, agent };
    }));
    const [source, target] = sandboxes;
    const foreign = await createSandbox(other.id, 'Foreign sandbox');
    const rawCreate = await command({ action: 'create', platform: 'weixin', name: 'WeChat sandbox', sandboxId: source.id,
      credentials: { WEIXIN_TOKEN: 'wechat-private-token', WEIXIN_ACCOUNT_ID: 'wechat-account' } });
    expect(rawCreate.status).toBe(200);
    const { connectionId } = await rawCreate.json();
    const before = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(before).toMatchObject({ sandboxId: source.id, agentId: source.agent.id });
    const listing = await GET(new Request(`http://localhost?sandboxId=${target.id}`), { params: Promise.resolve({ slug: workspace.slug }) });
    expect((await listing.json()).connections).toEqual([]);
    expect((await GET(new Request(`http://localhost?sandboxId=${foreign.id}`), { params: Promise.resolve({ slug: workspace.slug }) })).status).toBe(404);
    expect((await command({ action: 'create', platform: 'weixin', sandboxId: foreign.id })).status).toBe(400);
    expect((await command({ action: 'update', connectionId, agentId: target.agent.id })).status).toBe(400);
    expect((await command({ action: 'move', connectionId, sandboxId: foreign.id })).status).toBe(400);
    expect((await command({ action: 'move', connectionId, sandboxId: target.id }, other.slug)).status).toBe(404);

    await db.agentChannelConnection.update({ where: { id: connectionId }, data: { status: 'running', a2aActorId: identity.user!.id } });
    const run = (agent: string, sandbox: string, conversationId?: string) => runAgentChannelMessage({
      workspaceId: workspace.id, connectionId, agentId: agent, sandboxId: sandbox,
      rawBody: { message: 'Hello', conversationId, source: { chatId: 'wechat-user', userId: 'wechat-user', messageId: randomUUID() } },
    });
    const original = await run(source.agent.id, source.id);
    expect(original.status).toBe(200);
    const historyId = (original.body as { conversationId: string }).conversationId;
    vi.mocked(liveAgentChannelStatus).mockReturnValue('running');
    vi.mocked(startAgentChannelRunner).mockResolvedValue({});
    vi.mocked(stopAgentChannelRunner).mockClear();
    vi.mocked(startAgentChannelRunner).mockClear();
    const moved = await command({ action: 'move', connectionId, sandboxId: target.id });
    expect(moved.status).toBe(200);
    expect(JSON.stringify(await moved.json())).not.toContain('wechat-private-token');
    const after = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after).toMatchObject({ sandboxId: target.id, agentId: target.agent.id, credentials: before.credentials, config: before.config, inboundTokenHash: before.inboundTokenHash });
    expect(vi.mocked(stopAgentChannelRunner).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startAgentChannelRunner).mock.invocationCallOrder[0]);
    await db.agentChannelConnection.update({ where: { id: connectionId }, data: { status: 'running', a2aActorId: identity.user!.id } });
    expect((await run(source.agent.id, source.id)).status).toBe(404);
    expect((await run(target.agent.id, target.id, historyId)).status).toBe(404);
    const targetReply = await run(target.agent.id, target.id);
    expect(targetReply.status).toBe(200);
    const targetBinding = await nativeBinding((targetReply.body as { conversationId: string }).conversationId);
    expect(targetBinding.context).toMatchObject({ targetKind: 'local', agentId: target.agent.id });
    expect(targetBinding.lastTask.grant).toMatchObject({ actorId: identity.user!.id });
    expect((await nativeBinding(historyId)).context.agentId).toBe(source.agent.id);
    expect(runNativeEntry).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'channel', channelId: connectionId,
      actorId: identity.user!.id, agentId: target.agent.id }));
    expect(await db.conversation.findUnique({ where: { id: historyId } })).toMatchObject({ agentId: source.agent.id });

    vi.mocked(startAgentChannelRunner).mockResolvedValueOnce({ error: 'Cannot connect' }).mockResolvedValue({});
    expect((await command({ action: 'move', connectionId, sandboxId: source.id })).status).toBe(400);
    expect(await db.agentChannelConnection.findUnique({ where: { id: connectionId } })).toMatchObject({ sandboxId: target.id, agentId: target.agent.id, credentials: before.credentials });

    const empty = await createSandbox(workspace.id, 'Unassigned');
    expect((await command({ action: 'move', connectionId, sandboxId: empty.id })).status).toBe(200);
    expect(await db.agentChannelConnection.findUnique({ where: { id: connectionId } })).toMatchObject({ sandboxId: empty.id, agentId: null, status: 'stopped', credentials: before.credentials });
    await command({ action: 'delete', connectionId });
  });

  it('requires an account and refuses simple cross-origin form requests', async () => {
    const user = identity.user;
    identity.user = null;
    try {
      expect((await GET(new Request('http://localhost'), { params: Promise.resolve({ slug: workspace.slug }) })).status).toBe(401);
    } finally { identity.user = user; }
    expect((await POST(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }), {
      params: Promise.resolve({ slug: workspace.slug }),
    })).status).toBe(415);
  });

  it('creates a draft, binds and edits it without returning secrets, and keeps workspace boundaries', async () => {
    const created = await command({ action: 'create', platform: 'discord', name: 'Support' });
    expect(created.status).toBe(200);
    const data = await created.json();
    const connectionId = data.connectionId;
    expect(data.connections.find((connection: { id: string }) => connection.id === connectionId)).toMatchObject({ agentId: null, status: 'setup_required' });
    expect(JSON.stringify(data)).not.toMatch(/inboundToken|credentials"|workspaceId|runnerPid/);

    const updated = await command({ action: 'update', connectionId, agentId, name: 'Renamed', credentials: {
      DISCORD_BOT_TOKEN: 'private-bot-secret', DISCORD_ALLOWED_USERS: '42',
    } });
    expect(updated.status).toBe(200);
    const view = await updated.json();
    expect(JSON.stringify(view)).not.toContain('private-bot-secret');
    expect(view.connections.find((connection: { id: string }) => connection.id === connectionId)).toMatchObject({ name: 'Renamed', agentId, credentialValues: { DISCORD_ALLOWED_USERS: '42' } });
    expect((await command({ action: 'update', connectionId, credentials: { DISCORD_BOT_TOKEN: '', DISCORD_ALLOWED_USERS: '' } })).status).toBe(200);
    const raw = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptChannelCredentials(raw.credentials)).toEqual({ DISCORD_BOT_TOKEN: 'private-bot-secret' });
    expect(JSON.stringify(raw.credentials)).not.toContain('private-bot-secret');

    expect((await command({ action: 'update', connectionId, agentId: foreignAgentId })).status).toBe(400);
    for (const action of ['update', 'start', 'stop', 'delete', 'pair', 'check', 'apply']) {
      expect((await command({ action, connectionId }, other.slug)).status).toBe(404);
    }
    const logs = await GET(new Request(`http://localhost?logs=${connectionId}`), { params: Promise.resolve({ slug: other.slug }) });
    expect(logs.status).toBe(404);
    expect((await command({ action: 'update', connectionId, credentials: { NODE_OPTIONS: '--require=bad' } })).status).toBe(400);
    expect((await command({ action: 'start', connectionId })).status).toBe(400);
    expect((await command({ action: 'delete', connectionId })).status).toBe(200);
    expect(await db.agentChannelConnection.findUnique({ where: { id: connectionId } })).toBeNull();
  });

  it('polls Feishu registration and stores its device code and app secret encrypted', async () => {
    const created = await (await command({ action: 'create', platform: 'feishu', name: 'Feishu QR', credentials: { FEISHU_DOMAIN: 'lark' } })).json();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ supported: true }))
      .mockResolvedValueOnce(Response.json({ device_code: 'private-device-code', verification_uri_complete: 'https://accounts.larksuite.com/qr/test', interval: 5, expires_in: 600 }))
      .mockResolvedValueOnce(Response.json({ client_id: 'cli_test', client_secret: 'private-app-secret' }));
    vi.stubGlobal('fetch', fetch);
    const paired = await command({ action: 'pair', connectionId: created.connectionId });
    expect(paired.status).toBe(200);
    expect(JSON.stringify(await paired.json())).not.toContain('private-device-code');
    expect(fetch.mock.calls[0][0]).toBe('https://accounts.larksuite.com/oauth/v1/app/registration');
    expect(fetch.mock.calls[1][1].body).toContain('action=begin');
    const checked = await command({ action: 'check', connectionId: created.connectionId });
    expect(checked.status).toBe(200);
    const data = await checked.json();
    const channel = data.connections.find((item: { id: string }) => item.id === created.connectionId);
    expect(channel).toMatchObject({ pairing: { status: 'ready' }, missingStartCredentialNames: [], credentialValues: { FEISHU_APP_ID: 'cli_test', FEISHU_DOMAIN: 'lark' } });
    expect(JSON.stringify(data)).not.toContain('private-app-secret');
    const raw = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: created.connectionId } });
    expect(decryptChannelCredentials(raw.credentials).FEISHU_APP_SECRET).toBe('private-app-secret');
  });

  it('isolates two bots in the same chat, handles commands, and rejects stopped or unauthorized ingress', async () => {
    await enableNativeAgent(agentId);
    const channels = await Promise.all(['Bot 1', 'Bot 2'].map((name) => createAgentChannelConnection({
      workspaceId: workspace.id, agentId, platform: 'telegram', name,
      credentials: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ALLOWED_USERS: '42' },
    })));
    const [first, second] = channels.map((channel) => channel.connection!);
    await db.agentChannelConnection.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { status: 'running', a2aActorId: identity.user!.id } });
    const run = (connectionId: string, message: string, extras = {}) => runAgentChannelMessage({
      connectionId, workspaceId: workspace.id, agentId,
      rawBody: { message, source: { userId: '42', chatId: 'same-chat', platform: 'spoofed', chatType: 'dm', messageId: randomUUID() }, ...extras },
    });
    const a = await run(first.id, 'Hello');
    const b = await run(second.id, 'Hello');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    if (a.status !== 200 || b.status !== 200 || !('conversationId' in a.body) || !('conversationId' in b.body)) throw new Error('Missing reply');
    expect(a.body.conversationId).not.toBe(b.body.conversationId);
    expect(a.body.platform).toBe('telegram');
    expect((await run(first.id, 'Cross-channel', { conversationId: b.body.conversationId })).status).toBe(404);
    const whoami = await run(first.id, '/whoami');
    expect(whoami.body).toMatchObject({ conversationId: a.body.conversationId, message: expect.stringContaining('User ID: 42') });
    const reset = await run(first.id, '/new');
    expect(reset.body).toMatchObject({ conversationId: expect.not.stringMatching(a.body.conversationId) });
    const next = await run(first.id, 'Fresh');
    expect(next.body).toMatchObject({ conversationId: (reset.body as { conversationId: string }).conversationId });
    expect((await run(first.id, 'Denied', { source: { chatId: 'same-chat', userId: '43' } })).status).toBe(403);
    await db.agentChannelConnection.update({ where: { id: first.id }, data: { status: 'stopped' } });
    expect((await run(first.id, 'Stopped')).status).toBe(409);
    await db.agentChannelConnection.update({ where: { id: first.id }, data: { agentId: null } });
    expect((await runAgentChannelMessage({ connectionId: first.id, workspaceId: workspace.id, agentId: null, rawBody: { message: 'Unbound' } })).status).toBe(409);
  });
});
