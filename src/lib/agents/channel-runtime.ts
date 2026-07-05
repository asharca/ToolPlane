import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { db } from '@/lib/db';
import { decryptSecretText } from '@/lib/security/secrets';
import { decryptChannelCredentials } from '@/lib/agents/channel-connections';
import { hostedRunnerSpec } from '@/lib/agents/platform-runner';
import { getMessagingPlatform, missingStartCredentialNames } from '@/lib/agents/platforms';
import { runnerStderrToLastError, runnerStdoutIndicatesConnected } from '@/lib/agents/channel-runtime-logs';

type RunnerState = {
  child: ChildProcessWithoutNullStreams;
  workspaceId: string;
  connectionId: string;
  startedAt: Date;
};

declare global {
  var __toolplaneAgentChannelRunners: Map<string, RunnerState> | undefined;
}

function runners() {
  globalThis.__toolplaneAgentChannelRunners ??= new Map();
  return globalThis.__toolplaneAgentChannelRunners;
}

function serverUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3002').replace(/\/$/, '');
}

export function liveAgentChannelStatus(connectionId: string): 'running' | 'stopped' {
  const state = runners().get(connectionId);
  return state && !state.child.killed ? 'running' : 'stopped';
}

export async function startAgentChannelRunner(workspaceId: string, connectionId: string): Promise<{ error?: string }> {
  if (liveAgentChannelStatus(connectionId) === 'running') return {};

  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  const spec = hostedRunnerSpec(row.platform);
  if (!spec) return { error: 'This platform uses callback delivery and does not need a hosted runner.' };
  const platform = getMessagingPlatform(row.platform);
  if (!platform) return { error: `Unsupported platform: ${row.platform}` };

  const hermesRoot = process.env.HERMES_ROOT || process.env.TOOLPLANE_HERMES_ROOT;
  if (!hermesRoot) {
    const message = 'Hermes runner is not configured. Compose images bundle it at /opt/hermes-agent; local pnpm dev needs TOOLPLANE_HERMES_ROOT.';
    await db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { status: 'error', lastError: message },
    });
    return { error: message };
  }

  const credentials = decryptChannelCredentials(row.credentials);
  const missing = Array.from(new Set([
    ...missingStartCredentialNames(platform, credentials),
    ...spec.requiredEnv.filter((name) => !credentials[name]?.trim()),
  ]));
  if (missing.length) {
    const message = `Missing required credentials: ${missing.join(', ')}`;
    await db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { status: 'setup_required', lastError: message },
    });
    return { error: message };
  }

  const runnerPath = 'scripts/agent-channel-runner.py';
  const python = process.env.TOOLPLANE_PYTHON || process.env.PYTHON || 'python3';
  const token = decryptSecretText(row.inboundTokenSecret);
  const child = spawn(python, [runnerPath], {
    env: {
      ...process.env,
      ...credentials,
      HERMES_ROOT: hermesRoot,
      TOOLPLANE_SERVER_URL: serverUrl(),
      TOOLPLANE_CHANNEL_CONNECTION_ID: connectionId,
      TOOLPLANE_CHANNEL_TOKEN: token,
      TOOLPLANE_MESSAGING_PLATFORM: row.platform,
      PYTHONPATH: [hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    },
  });

  child.stdout.on('data', (chunk) => {
    if (!runnerStdoutIndicatesConnected(String(chunk))) return;
    void db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { status: 'running', lastError: null },
    }).catch(() => {});
  });

  child.stderr.on('data', (chunk) => {
    const message = runnerStderrToLastError(String(chunk));
    if (message) {
      void db.agentChannelConnection.update({
        where: { id: connectionId },
        data: { lastError: message },
      }).catch(() => {});
    }
  });
  child.on('exit', (code, signal) => {
    runners().delete(connectionId);
    const clean = code === 0 || signal === 'SIGTERM';
    void db.agentChannelConnection.update({
      where: { id: connectionId },
      data: {
        status: clean ? 'stopped' : 'error',
        runnerPid: null,
        lastError: clean ? null : `Runner exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
      },
    }).catch(() => {});
  });

  runners().set(connectionId, { child, workspaceId, connectionId, startedAt: new Date() });
  await db.agentChannelConnection.update({
    where: { id: connectionId },
    data: { status: 'running', runnerPid: child.pid ?? null, lastStartedAt: new Date(), lastError: null },
  });

  return {};
}

export async function stopAgentChannelRunner(workspaceId: string, connectionId: string) {
  const state = runners().get(connectionId);
  if (state?.workspaceId === workspaceId) {
    state.child.kill('SIGTERM');
    runners().delete(connectionId);
  }
  await db.agentChannelConnection.updateMany({
    where: { id: connectionId, workspaceId },
    data: { status: 'stopped', runnerPid: null },
  });
}
