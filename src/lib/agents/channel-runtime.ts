import 'server-only';
import type { UIMessage } from 'ai';
import { db } from '@/lib/db';
import { decryptChannelCredentials } from './channel-connections';
import { hostedRunnerSpec } from './platform-runner';
import { getMessagingPlatform, missingStartCredentialNames } from './platforms';
import { appendAgentChannelLog } from './channel-runtime-logs';
import { channelSenderAllowed } from './channel-access';
import { getChannelSandbox } from './channel-sandboxes';
import { createChannelAdapter } from './channels/create-adapter';
import type { ChannelAdapter, ChannelCommandEvent, ChannelLogEvent, ChannelMessageEvent, ChannelStatusEvent } from './channels/ChannelAdapter';

type RunnerState = {
  adapter: ChannelAdapter;
  workspaceId: string;
  agentId: string;
  sandboxId: string | null;
  status: 'running' | 'starting';
  cleanup: () => void;
  pendingWrite: Promise<unknown>;
  pendingMessages: number;
  queues: Map<string, Promise<void>>;
};
declare global {
  var __toolplaneAgentChannelAdapters: Map<string, RunnerState> | undefined;
  var __toolplaneAgentChannelStarts: Map<string, Promise<{ error?: string }>> | undefined;
}
function runners() { return globalThis.__toolplaneAgentChannelAdapters ??= new Map(); }
function starts() { return globalThis.__toolplaneAgentChannelStarts ??= new Map(); }

export function liveAgentChannelStatus(connectionId: string): 'running' | 'starting' | 'stopped' {
  return runners().get(connectionId)?.status ?? 'stopped';
}

export async function reconcileAgentChannelRunners() {
  const channels = await db.agentChannelConnection.findMany({
    where: { status: { in: ['running', 'starting'] }, agentId: { not: null } },
    select: { id: true, workspaceId: true, platform: true },
  });
  let started = 0;
  for (const channel of channels) {
    if (!hostedRunnerSpec(channel.platform)) continue;
    try { if (!(await startAgentChannelRunner(channel.workspaceId, channel.id)).error) started += 1; }
    catch { appendAgentChannelLog(channel.id, 'error', 'Channel could not be restored after restart.'); }
  }
  return started;
}

export function startAgentChannelRunner(workspaceId: string, connectionId: string): Promise<{ error?: string }> {
  const key = `${workspaceId}:${connectionId}`;
  const pending = starts().get(key);
  if (pending) return pending;
  const operation = start(workspaceId, connectionId).finally(() => starts().delete(key));
  starts().set(key, operation);
  return operation;
}

async function start(workspaceId: string, connectionId: string): Promise<{ error?: string }> {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  if (row.sandboxId) {
    const sandbox = await getChannelSandbox(workspaceId, row.sandboxId);
    if (!sandbox?.agentId) return { error: 'Assign an Agent to this sandbox before starting the channel.' };
    if (row.agentId !== sandbox.agentId) {
      if (runners().has(connectionId)) return { error: 'Stop the channel before changing its sandbox Agent.' };
      await db.agentChannelConnection.update({ where: { id: row.id }, data: { agentId: sandbox.agentId } });
      row.agentId = sandbox.agentId;
    }
  }
  if (!row.agentId) return { error: 'Bind an agent before starting the channel.' };
  if (runners().has(connectionId)) return {};
  const platform = getMessagingPlatform(row.platform);
  if (!platform || !hostedRunnerSpec(row.platform)) return { error: 'This platform has no native channel transport.' };
  const credentials = decryptChannelCredentials(row.credentials);
  const secrets = platform.credentials.filter((field) => field.secret).map((field) => credentials[field.name]);
  const log = (level: 'info' | 'error', message: string) => appendAgentChannelLog(connectionId, level, message, secrets);
  const missing = missingStartCredentialNames(platform, credentials);
  if (missing.length) {
    const error = `Missing required credentials: ${missing.join(', ')}`;
    await db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId }, data: { status: 'setup_required', lastError: error } });
    return { error };
  }

  let state: RunnerState | undefined;
  try {
    const adapter = await createChannelAdapter({ id: row.id, agentId: row.agentId, platform: row.platform, credentials });
    const active: RunnerState = { adapter, workspaceId, agentId: row.agentId, sandboxId: row.sandboxId, status: 'starting', cleanup: () => {},
      pendingWrite: Promise.resolve(), pendingMessages: 0, queues: new Map() };
    state = active;
    const controller = new AbortController();
    active.cleanup = () => controller.abort();
    runners().set(connectionId, active);
    const current = () => runners().get(connectionId) === active;
    const update = (data: { status?: string; lastError: string | null }) => {
      active.pendingWrite = active.pendingWrite.then(() => current()
        ? db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId }, data }) : undefined).catch(() => {});
    };
    adapter.on('log', (entry: ChannelLogEvent) => { if (current()) log(entry.level === 'error' ? 'error' : 'info', entry.message); });
    adapter.on('statusChange', (event: ChannelStatusEvent) => {
      if (!current()) return;
      active.status = event.connected ? 'running' : 'starting';
      update({ status: active.status, lastError: event.error ? log('error', event.error) : null });
    });
    adapter.on('fatal', (message: string) => {
      if (!current()) return;
      active.cleanup();
      runners().delete(connectionId);
      void adapter.disconnect().catch(() => {});
      const error = log('error', message);
      void active.pendingWrite.then(() => runners().has(connectionId) ? undefined : db.agentChannelConnection.updateMany({
        where: { id: connectionId, workspaceId }, data: { status: 'error', runnerPid: null, lastError: error },
      })).catch(() => {});
    });

    const enqueue = (event: ChannelMessageEvent) => {
      if (!current() || !channelSenderAllowed(row.platform, credentials, { userId: event.userId, chatId: event.chatId }, event.roleIds)) return;
      // ponytail: cap queued events per channel; use a durable queue for high-volume channels.
      if (active.pendingMessages >= 20) { log('error', 'Channel message queue is full.'); return; }
      const key = event.conversationId || event.chatId;
      active.pendingMessages += 1;
      const operation = (active.queues.get(key) ?? Promise.resolve()).then(async () => {
        if (!current()) return;
        const replyOptions = { replyToMessageId: row.platform === 'telegram' && event.messageId ? Number(event.messageId) : event.messageId,
          replyInThread: event.replyInThread };
        await adapter.sendTypingIndicator(event.chatId, replyOptions).catch(() => {});
        const images = (event.images ?? []).slice(0, 20);
        const files = (event.files ?? []).slice(0, 20 - images.length);
        const attachmentParts: UIMessage['parts'] = [...images, ...files].map((file) => ({
          type: 'file', mediaType: file.media_type, url: `data:${file.media_type};base64,${file.data}`,
          ...('filename' in file ? { filename: String(file.filename) } : {}),
        }));
        const { runAgentChannelMessage } = await import('./message-service');
        const result = await runAgentChannelMessage({
          workspaceId, connectionId, agentId: active.agentId, sandboxId: active.sandboxId, attachmentParts, signal: controller.signal,
          rawBody: {
            message: event.text.trim() || 'Attachment',
            metadata: { roleIds: event.roleIds },
            source: { platform: row.platform, chatId: event.chatId, userId: event.userId || undefined,
              userName: event.userName || undefined, messageId: event.messageId,
              ...(event.conversationId && event.conversationId !== event.chatId ? { threadId: event.conversationId } : {}) },
            attachments: [...images.map((image) => ({ type: 'image', mimeType: image.media_type })),
              ...files.map((file) => ({ type: 'file', mimeType: file.media_type, name: file.filename.slice(0, 240), size: file.size }))],
          },
        });
        if (!current()) return;
        if ('error' in result.body) { log('error', result.body.error); return; }
        if (result.body.delivery === 'message') await adapter.sendMessage(event.chatId, result.body.message, replyOptions);
      }).catch((error: unknown) => { log('error', error instanceof Error ? error.message : 'Channel message failed.'); }).finally(() => {
        active.pendingMessages -= 1;
        if (active.queues.get(key) === operation) active.queues.delete(key);
      });
      active.queues.set(key, operation);
    };
    adapter.on('message', enqueue);
    adapter.on('command', (event: ChannelCommandEvent) => enqueue({ ...event, text: `/${event.command}${event.args ? ` ${event.args}` : ''}` }));
    const bindingTimer = setInterval(() => {
      void Promise.all([
        db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId, agentId: active.agentId, sandboxId: active.sandboxId }, select: { id: true } }),
        active.sandboxId ? getChannelSandbox(workspaceId, active.sandboxId) : null,
      ]).then(([bound, sandbox]) => {
        if ((!bound || (active.sandboxId && sandbox?.agentId !== active.agentId)) && current()) return stopAgentChannelRunner(workspaceId, connectionId);
      }).catch(() => {});
    }, 5000);
    bindingTimer.unref?.();
    active.cleanup = () => { clearInterval(bindingTimer); controller.abort(); };
    await db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId },
      data: { status: 'starting', lastError: null, runnerPid: null, lastStartedAt: new Date() } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([adapter.connect(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Channel connection timed out.')), 30000);
      })]);
    } finally { clearTimeout(timeout); }
    await active.pendingWrite;
    return {};
  } catch (error) {
    state?.cleanup();
    if (state && runners().get(connectionId) === state) runners().delete(connectionId);
    await state?.adapter.disconnect().catch(() => {});
    await state?.pendingWrite;
    const message = log('error', error instanceof Error ? error.message : 'Channel connection failed.');
    await db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId }, data: { status: 'error', runnerPid: null, lastError: message } });
    return { error: message };
  }
}

export async function stopAgentChannelRunner(workspaceId: string, connectionId: string) {
  await starts().get(`${workspaceId}:${connectionId}`)?.catch(() => {});
  const state = runners().get(connectionId);
  if (state?.workspaceId === workspaceId) {
    state.cleanup();
    runners().delete(connectionId);
    await state.adapter.disconnect().catch(() => { appendAgentChannelLog(connectionId, 'error', 'Channel disconnect failed.'); });
    await state.pendingWrite;
    appendAgentChannelLog(connectionId, 'info', 'Channel stopped.');
  }
  await db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId }, data: { status: 'stopped', runnerPid: null, lastError: null } });
}
