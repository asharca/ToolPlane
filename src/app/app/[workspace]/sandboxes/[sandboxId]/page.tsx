import { getLocale, getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { Cpu, FolderOpen, Globe2, Laptop, Terminal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getSandbox } from '@/lib/sandboxes/queries';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';
import {
  connectorClientCommand,
  connectorFromConfig,
  DEFAULT_CONNECTOR_REMOTE_ROOT,
  hashConnectorToken,
  isConnectorToken,
  type SandboxConnectorConfig,
} from '@/lib/sandboxes/connector';
import { connectorStatus } from '@/lib/sandboxes/connector-broker';
import { readConnectorSetupTokenCookie } from '@/lib/sandboxes/connector-setup-token';
import {
  deleteSandboxAction,
  generateConnectorCommandAction,
  renameSandboxAction,
  restartSandboxAction,
  startSandboxAction,
  stopSandboxAction,
  updateSandboxEnvAction,
} from '@/lib/sandboxes/actions';
import { readSandboxEnv, sandboxEnvToText } from '@/lib/sandboxes/env';
import { effectiveStatus } from '@/lib/process/supervisor';
import { mcpRpc } from '@/lib/process/mcp-client';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { DashboardPage, DashboardPanel } from '@/components/dashboard/DashboardUI';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import { SandboxConnectorStatus } from '@/components/dashboard/sandboxes/SandboxConnectorStatus';
import { SandboxSettingsDialog } from '@/components/dashboard/sandboxes/SandboxSettingsDialog';
import { SandboxDataManagement } from '@/components/dashboard/sandboxes/SandboxDataManagement';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

const rowButton = 'text-xs text-muted-foreground transition-colors hover:text-foreground';

function modeLabel(kind: string): string {
  if (kind === 'connector') return 'User connector';
  if (kind === 'ssh') return 'Legacy direct SSH disabled';
  if (kind === 'host') return 'Disabled host root';
  return 'Docker Linux';
}

function backingLabel(sandbox: { kind: string; image: string | null; config: unknown; hostRoot?: string | null }): string {
  if (sandbox.kind === 'connector') {
    const connector = connectorFromConfig(sandbox.config);
    return connector
      ? `WebSocket agent -> ${connector.remoteRoot}`
      : 'Connector config missing';
  }
  if (sandbox.kind === 'host') return 'Legacy host pass-through is disabled';
  if (sandbox.kind === 'ssh') return 'Legacy direct SSH is disabled';
  return sandbox.image ?? '';
}

function connectorPortLabel(connector: SandboxConnectorConfig | null): string {
  return connector ? 'ws agent' : 'missing connector';
}

function CommandBlock({ label, command, copyLabel }: { label: string; command: string; copyLabel: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <CopyButton text={command} label={copyLabel} />
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-foreground">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function parseToolText(result: Record<string, unknown> | null): string | null {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : null;
}

function parseInitialDirectory(result: Record<string, unknown> | null): {
  path: string;
  entries: SandboxFileEntry[];
} {
  const text = parseToolText(result);
  if (!text) return { path: '.', entries: [] };
  return parseSandboxDirectoryText(text) ?? { path: '.', entries: [] };
}

export default async function SandboxDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; sandboxId: string }>;
}) {
  const t = await getTranslations('console.sandboxes');
  const common = await getTranslations('common');
  const locale = await getLocale();
  const { workspace: slug, sandboxId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const sandbox = await getSandbox(ws.id, sandboxId);
  if (!sandbox) notFound();

  const status = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
  const running = status === 'running' || status === 'provisioning';
  const lifecycleBlocked = [
    'copying',
    'copy_failed',
    'restoring',
    'restore_failed',
    'restore_cleanup_required',
    'deleting',
  ]
    .includes(status);
  const connector = connectorFromConfig(sandbox.config);
  const tokenParam = connector ? (await readConnectorSetupTokenCookie(sandbox.id))?.trim() ?? '' : '';
  const token = connector
    && isConnectorToken(tokenParam)
    && hashConnectorToken(tokenParam) === connector.tokenHash
      ? tokenParam
      : undefined;
  const connectorLive = sandbox.kind === 'connector' ? connectorStatus(sandbox.id) : null;
  const connectorWaiting = Boolean(connector && running && !connectorLive?.connected);
  const connectorRoot = connectorLive?.root ?? connector?.remoteRoot;
  const envText = sandboxEnvToText(readSandboxEnv(sandbox.config));
  const disabledLegacy = sandbox.kind === 'host' || sandbox.kind === 'ssh' || (sandbox.kind === 'connector' && !connector);
  const canUseConsole = status === 'running'
    && !disabledLegacy
    && (sandbox.kind !== 'connector' || Boolean(connectorLive?.connected));
  const showConnectorSetup = Boolean(connector && !connectorLive?.connected);
  const initialDirectory = canUseConsole
    ? parseInitialDirectory(
        await mcpRpc(
          sandbox.deploymentId,
          'tools/call',
          { name: 'list_dir', arguments: { path: '.' } },
          5000,
        ),
      )
    : { path: '.', entries: [] };
  const connectorSettings = connector ? (
    <div className="space-y-4">
      <form action={generateConnectorCommandAction} className="space-y-3">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="sandboxId" value={sandbox.id} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-3 text-xs text-muted-foreground">
          <Globe2 className="size-4 shrink-0" />
          <span>{t('platformUrl')}</span>
          <span className="break-all font-mono text-foreground">{connector.serverUrl}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {t('automatic')}
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <label className="block space-y-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('localRoot')}
            <span className="relative block">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                name="connectorRemoteRoot"
                required
                defaultValue={connector.remoteRoot || DEFAULT_CONNECTOR_REMOTE_ROOT}
                className="ui-input ui-input-icon h-9 w-full font-mono text-xs"
                aria-describedby="connector-root-hint"
              />
            </span>
            <span id="connector-root-hint" className="block text-[11px] font-normal normal-case leading-4 tracking-normal text-muted-foreground">
              {t('directoryOnTheUsersMachineExposedToTheAgent')}
            </span>
          </label>
          <SubmitButton pendingLabel={t('generating')} className="ui-button-primary mt-5 h-9 w-full text-sm lg:w-auto">
            {token ? t('updateAndRegenerateCommand') : t('generateCommand')}
          </SubmitButton>
        </div>
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        {token ? (
          <div className="min-w-0 space-y-3">
            <CommandBlock
              label={t('linuxMacosWindows')}
              command={connectorClientCommand(connector, token)}
              copyLabel={t('copyCommand')}
            />
            <p className="text-xs leading-5 text-muted-foreground">{t('connectorRequirements')}</p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-background px-3 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('runOnTheUserMachine')}
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('generateAFreshConnectionCommandToMintATokenForThisSandbox')}
            </p>
          </div>
        )}
        <div className="min-w-0 rounded-md border border-border bg-muted/35 px-3 py-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{t('connectionModel')}</div>
          <p className="mt-1">
            {t('thePlatformDoesNotDialTheUserMachineTheConnectorCliOpensAWebsocketSessionTo')} <span className="font-mono text-foreground">{connector.serverUrl}</span>{t('thenExposes')} <span className="font-mono text-foreground">{connectorRoot}</span> {t('asThisSandboxRoot')}
          </p>
          {token ? (
            <p className="mt-2 text-foreground">
              {t('thisGeneratedTokenIsShownOnlyInThisUrlKeepTheCommandSomewhereSafeBeforeLeavingThePage')}
            </p>
          ) : (
            <p className="mt-2">
              {t('tokensAreGeneratedServersideAndStoredOnlyAsHashes')}
            </p>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <ProvisioningRefresher
        active={status === 'provisioning'
          || status === 'copying'
          || status === 'restoring'
          || status === 'restore_cleanup_required'
          || connectorWaiting}
      />
      <DashboardHeader
        breadcrumb={[
          { label: 'Sandboxes', href: `/app/${slug}/sandboxes` },
          { label: sandbox.name },
        ]}
      />
      <DashboardPage>
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {sandbox.kind === 'connector' ? <Laptop className="size-5" /> : <Terminal className="size-5" />}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold text-foreground">{sandbox.name}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{sandbox.slug}</span>
                  <span className="inline-flex items-center gap-1">
                    {sandbox.kind === 'connector' ? <Laptop className="size-3.5" /> : <Cpu className="size-3.5" />}
                    {modeLabel(sandbox.kind)}
                  </span>
                  <span className="max-w-[22rem] truncate font-mono">
                    {backingLabel(sandbox)}
                  </span>
                  <span className="font-mono">
                    {sandbox.kind === 'connector' ? connectorPortLabel(connector) : sandbox.network}
                  </span>
                  <span>{sandbox.agentLinks.length} {t('agents')}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={status} />
              {sandbox.kind === 'connector' && connector ? (
                <SandboxConnectorStatus
                  workspace={slug}
                  sandboxId={sandbox.id}
                  initialStatus={{
                    connected: Boolean(connectorLive?.connected),
                    connectedAt: connectorLive?.connectedAt ?? null,
                    lastSeen: connectorLive?.lastSeen ?? null,
                    root: connectorLive?.root ?? null,
                    platform: connectorLive?.platform ?? null,
                    arch: connectorLive?.arch ?? null,
                    shell: connectorLive?.shell ?? null,
                  }}
                />
              ) : null}
              <SandboxSettingsDialog
                title={t('sandboxSettings')}
                subtitle={sandbox.name}
                triggerLabel={t('settings')}
                closeLabel={t('close')}
              >
                <div className="divide-y divide-border">
                  <section className="pb-5">
                    <h3 className="text-sm font-semibold text-foreground">{t('generalSettings')}</h3>
                    <form action={renameSandboxAction} className="mt-3">
                      <input type="hidden" name="workspace" value={slug} />
                      <input type="hidden" name="sandboxId" value={sandbox.id} />
                      <fieldset disabled={lifecycleBlocked} className="flex items-end gap-2 disabled:opacity-60">
                        <label className="min-w-0 flex-1 space-y-1.5 text-xs font-medium text-muted-foreground">
                          {t('sandboxName')}
                          <input
                            name="name"
                            defaultValue={sandbox.name}
                            maxLength={80}
                            className="ui-input h-9 min-w-0 text-sm"
                          />
                        </label>
                        <SubmitButton pendingLabel={t('renaming')} className="ui-button-secondary h-9 text-xs">
                          {t('rename')}
                        </SubmitButton>
                      </fieldset>
                    </form>
                  </section>

                  {connector && !showConnectorSetup ? (
                    <section className="py-5">
                      <h3 className="text-sm font-semibold text-foreground">{t('connectorSetup')}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('runThisCommandOnTheUserMachineTheClientConnectsBackToThePlatformOverWebsocketAndExecutesSandboxOperationsLocally')}
                      </p>
                      <div className="mt-4">{connectorSettings}</div>
                    </section>
                  ) : null}

                  <section className="py-5">
                    <h3 className="text-sm font-semibold text-foreground">{t('environmentVariables')}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('changesRestartTheSandboxContainerButKeepFiles')}</p>
                    <form action={updateSandboxEnvAction} className="mt-3">
                      <input type="hidden" name="workspace" value={slug} />
                      <input type="hidden" name="sandboxId" value={sandbox.id} />
                      <fieldset disabled={lifecycleBlocked} className="space-y-3 disabled:opacity-60">
                        <textarea
                          name="env"
                          defaultValue={envText}
                          rows={5}
                          spellCheck={false}
                          placeholder={t('envPlaceholder')}
                          className="ui-input min-h-28 w-full resize-y font-mono text-xs leading-5"
                          aria-label={t('environmentVariables')}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">{t('environmentVariablesHint')}</p>
                          <SubmitButton pendingLabel={t('saving')} className="ui-button-secondary h-8 text-xs">
                            {t('saveEnvironment')}
                          </SubmitButton>
                        </div>
                      </fieldset>
                    </form>
                  </section>

                  {sandbox.kind === 'docker' && status !== 'copy_failed' && status !== 'deleting' ? (
                    <SandboxDataManagement
                      workspace={slug}
                      sandboxId={sandbox.id}
                      sandboxName={sandbox.name}
                      disabled={status === 'provisioning'
                        || status === 'copying'
                        || status === 'restoring'
                        || status === 'restore_cleanup_required'}
                      disabledLabel={status === 'restore_cleanup_required'
                        ? t('statusCleanupPending')
                        : undefined}
                      creationDisabled={status === 'restore_failed'}
                      snapshots={sandbox.snapshots.map((snapshot) => ({
                        id: snapshot.id,
                        name: snapshot.name,
                        status: snapshot.status,
                        error: snapshot.error ? 'error' : null,
                        createdAt: formatInTimeZone(snapshot.createdAt, timeZone, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        }, locale),
                      }))}
                    />
                  ) : null}

                  <section className="pt-5">
                    <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">{t('dangerZone')}</h3>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                        {t(sandbox.kind === 'docker'
                          ? 'deleteSandboxDescription'
                          : 'deleteExternalSandboxDescription')}
                      </p>
                      <form action={deleteSandboxAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="sandboxId" value={sandbox.id} />
                        <ConfirmSubmitButton
                          triggerLabel={t('delete')}
                          confirmLabel={common('confirm')}
                          cancelLabel={common('cancel')}
                          prompt={t(sandbox.kind === 'docker'
                            ? 'deleteSandboxPrompt'
                            : 'deleteExternalSandboxPrompt', { name: sandbox.name })}
                          pendingLabel={t('deletingSandbox')}
                          triggerClassName="ui-button-secondary h-9 border-red-200 text-sm text-red-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                          confirmClassName="ui-button-primary h-9 bg-red-600 text-sm text-white hover:bg-red-700"
                          cancelClassName="ui-button-ghost h-9 text-sm"
                          promptClassName="max-w-sm text-xs text-muted-foreground"
                        />
                      </form>
                    </div>
                  </section>
                </div>
              </SandboxSettingsDialog>
              {lifecycleBlocked ? null : (
                <Link href={`/app/${slug}/agents`} className={rowButton}>
                  {t('attachToAgent')}
                </Link>
              )}
              {disabledLegacy || lifecycleBlocked ? null : running ? (
                <>
                  <form action={stopSandboxAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="sandboxId" value={sandbox.id} />
                    <SubmitButton flash={false} pendingLabel={t('stopping')} className={rowButton}>
                      {t('stop')}
                    </SubmitButton>
                  </form>
                  <form action={restartSandboxAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="sandboxId" value={sandbox.id} />
                    <SubmitButton flash={false} pendingLabel={t('restarting')} className={rowButton}>
                      {t('restart')}
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <form action={startSandboxAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="sandboxId" value={sandbox.id} />
                  <SubmitButton flash={false} pendingLabel={t('starting')} className={rowButton}>
                    {t('start')}
                  </SubmitButton>
                </form>
              )}
            </div>
          </div>

          {sandbox.agentLinks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('attachedAgents')}</span>
              {sandbox.agentLinks.map((link) => (
                <Link key={link.agent.id} href={`/app/${slug}/agents/${link.agent.id}`} className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted">
                  {link.agent.name}
                </Link>
              ))}
            </div>
          ) : null}

          {showConnectorSetup && connector ? (
            <DashboardPanel
              title={t('connectorSetup')}
              description={t('runThisCommandOnTheUserMachineTheClientConnectsBackToThePlatformOverWebsocketAndExecutesSandboxOperationsLocally')}
            >
              {connectorSettings}
            </DashboardPanel>
          ) : (
            <SandboxConsole
              key={`${sandbox.id}:${canUseConsole ? connectorLive?.connectedAt ?? 'ready' : 'offline'}`}
              deploymentId={sandbox.deploymentId}
              running={canUseConsole}
              initialPath={initialDirectory.path}
              initialEntries={initialDirectory.entries}
              terminalSubtitle={sandbox.name}
              workspaceRoot={sandbox.kind === 'connector' ? connectorRoot : undefined}
              waitingForConnector={connectorWaiting}
            />
          )}
        </section>
      </DashboardPage>
    </>
  );
}
