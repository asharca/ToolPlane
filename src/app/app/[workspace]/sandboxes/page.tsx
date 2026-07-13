import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Bot, Boxes, Container, Cpu, HardDrive, Laptop, Terminal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listManagedAgentRuntimes, listSandboxes } from '@/lib/sandboxes/queries';
import {
  connectorFromConfig,
  type SandboxConnectorConfig,
} from '@/lib/sandboxes/connector';
import {
  deleteSandboxAction,
  restartSandboxAction,
  startSandboxAction,
  stopSandboxAction,
} from '@/lib/sandboxes/actions';
import {
  DEFAULT_SANDBOX_IMAGE,
  findSandboxImageOption,
} from '@/lib/sandboxes/images';
import { sandboxVolumeName } from '@/lib/sandboxes/runtime';
import { createHermesDashboardPath } from '@/lib/agents/hermes/token';
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import { SandboxCreateForm } from '@/components/dashboard/sandboxes/SandboxCreateForm';
import { SandboxConnectorStatus } from '@/components/dashboard/sandboxes/SandboxConnectorStatus';
import { HermesRuntimeDialogLauncher } from '@/components/dashboard/agents/HermesRuntimeDialog';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardSection,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

const rowButton = 'text-xs text-muted-foreground transition-colors hover:text-foreground';

function formatDate(d: Date, timeZone: string): string {
  return formatInTimeZone(d, timeZone, { month: 'short', day: 'numeric', year: 'numeric' }, 'en-US');
}

function formatDateTime(d: Date, timeZone: string): string {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }, 'en-US');
}

function compactVolumeName(sandboxId: string): string {
  const name = sandboxVolumeName(sandboxId);
  return name.length > 34 ? `${name.slice(0, 24)}...${name.slice(-7)}` : name;
}

function SandboxStat({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: number;
  icon: typeof Boxes;
  className?: string;
}) {
  return (
    <div className={`rounded-md border border-border bg-card px-4 py-3 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
    </div>
  );
}

function backingStore(sandbox: { kind: string; image: string | null; config: unknown; hostRoot?: string | null }): string {
  if (sandbox.kind === 'connector') {
    const connector = connectorFromConfig(sandbox.config);
    return connector
      ? `WebSocket connector -> ${connector.remoteRoot}`
      : 'Connector config missing';
  }
  if (sandbox.kind === 'ssh') return 'Legacy direct SSH disabled';
  if (sandbox.kind === 'host') return 'Legacy host root disabled';
  const image = sandbox.image ?? DEFAULT_SANDBOX_IMAGE;
  const option = findSandboxImageOption(image);
  return option ? option.name : image;
}

function modeLabel(kind: string): string {
  if (kind === 'connector') return 'Connector';
  if (kind === 'ssh') return 'Legacy SSH';
  if (kind === 'host') return 'Disabled host';
  return 'Docker';
}

function connectorMeta(connector: SandboxConnectorConfig | null): string {
  if (!connector) return 'waiting for config';
  return 'open sandbox to generate command';
}

export default async function SandboxesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const t = await getTranslations('console.sandboxes');
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [sandboxes, rawManagedRuntimes] = await Promise.all([
    listSandboxes(ws.id),
    listManagedAgentRuntimes(ws.id),
  ]);
  const managedRuntimes = rawManagedRuntimes.map((runtime) => ({
    ...runtime,
    dashboardUrl: createHermesDashboardPath(runtime.id),
  }));
  const managedStatus = (runtime: (typeof managedRuntimes)[number]) => (
    runtime.status === 'error' || runtime.status === 'setup_required'
      ? runtime.status
      : effectiveStatus(runtime.sandbox.deploymentId, runtime.sandbox.deployment.status)
  );
  const anyProvisioning = sandboxes.some((s) => effectiveStatus(s.deploymentId, s.deployment.status) === 'provisioning')
    || managedRuntimes.some((runtime) => managedStatus(runtime) === 'provisioning');
  const dockerCount = sandboxes.filter((s) => s.kind === 'docker').length;
  const connectorCount = sandboxes.filter((s) => s.kind === 'connector').length;
  const runningCount = sandboxes.filter((s) => {
    const status = effectiveStatus(s.deploymentId, s.deployment.status);
    return status === 'running' || status === 'provisioning';
  }).length + managedRuntimes.filter((runtime) => {
    const status = managedStatus(runtime);
    return status === 'running' || status === 'provisioning';
  }).length;
  const agentLinkCount = sandboxes.reduce((sum, sandbox) => sum + sandbox._count.agentLinks, 0);

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title={t('sandboxes')} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <SandboxCreateForm workspace={slug} />
          }
        >
          <p className="text-sm text-muted-foreground">
            {t('dockerLinuxWorkspacesAndUserMachinesConnectedByOnecommandWebsocketAgents')}
          </p>
        </DashboardToolbar>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <SandboxStat label={t('docker')} value={dockerCount} icon={Cpu} />
          <SandboxStat label={t('connectors')} value={connectorCount} icon={Laptop} />
          <SandboxStat label={t('managedRuntimes')} value={managedRuntimes.length} icon={Container} />
          <SandboxStat label={t('running')} value={runningCount} icon={Terminal} />
          <SandboxStat
            label={t('agentLinks')}
            value={agentLinkCount}
            icon={Boxes}
            className="col-span-2 xl:col-span-1"
          />
        </div>

        {managedRuntimes.length > 0 ? (
          <DashboardSection title={t('managedAgentSandboxes')} count={managedRuntimes.length}>
            <p className="-mt-1 mb-3 max-w-3xl text-xs leading-5 text-muted-foreground">
              {t('managedAgentSandboxesDescription')}
            </p>
            <div className="space-y-3 xl:hidden">
              {managedRuntimes.map((runtime) => {
                const status = managedStatus(runtime);
                const agentHref = `/app/${slug}/agents/${runtime.agent.id}`;
                return (
                  <article key={runtime.id} className="ui-panel p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300">
                          <Container className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-foreground">{runtime.sandbox.name}</h3>
                          <p className="truncate text-xs text-muted-foreground">{runtime.sandbox.slug}</p>
                        </div>
                      </div>
                      <StatusBadge status={status} />
                    </div>

                    {runtime.lastError ? (
                      <p className="mt-3 break-words rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        {runtime.lastError}
                      </p>
                    ) : null}

                    <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">{t('ownerAgent')}</dt>
                        <dd className="mt-1">
                          <Link href={agentHref} className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline">
                            <Bot className="size-3.5 text-muted-foreground" />
                            {runtime.agent.name}
                          </Link>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{t('lastSync')}</dt>
                        <dd className="mt-1 font-medium text-foreground">
                          {runtime.lastSyncedAt ? formatDateTime(runtime.lastSyncedAt, timeZone) : t('neverSynced')}
                        </dd>
                      </div>
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-muted-foreground">{t('imageAndStorage')}</dt>
                        <dd className="mt-1 min-w-0">
                          <div className="truncate text-foreground" title={runtime.image}>{runtime.image}</div>
                          <div
                            className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                            title={sandboxVolumeName(runtime.sandbox.id)}
                          >
                            <HardDrive className="size-3 shrink-0" />
                            <span className="truncate">{compactVolumeName(runtime.sandbox.id)}</span>
                          </div>
                        </dd>
                      </div>
                    </dl>

                    <HermesRuntimeDialogLauncher
                      runtime={{
                        name: runtime.sandbox.name,
                        agentId: runtime.agent.id,
                        deploymentId: runtime.sandbox.deploymentId,
                        dashboardUrl: runtime.dashboardUrl,
                      }}
                      className="mt-4 border-t border-border pt-3"
                    />
                  </article>
                );
              })}
            </div>
            <DashboardTable
              minWidth="58rem"
              className="hidden xl:block"
              headers={[
                { label: t('runtime') },
                { label: t('ownerAgent') },
                { label: 'Status' },
                { label: t('imageAndStorage') },
                { label: t('lastSync') },
                { label: 'Actions', align: 'right' },
              ]}
            >
              {managedRuntimes.map((runtime) => {
                const status = managedStatus(runtime);
                const agentHref = `/app/${slug}/agents/${runtime.agent.id}`;
                return (
                  <tr key={runtime.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300">
                          <Container className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{runtime.sandbox.name}</div>
                          <div className="text-xs text-muted-foreground">{runtime.sandbox.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={agentHref} className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline">
                        <Bot className="size-3.5 text-muted-foreground" />
                        {runtime.agent.name}
                      </Link>
                      <div className="mt-0.5 text-xs text-muted-foreground">{t('managedByAgent')}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={status} />
                      {runtime.lastError ? (
                        <div className="mt-1 max-w-48 truncate text-xs text-red-600" title={runtime.lastError}>
                          {runtime.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-sm px-4 py-3 text-xs text-muted-foreground">
                      <div className="truncate" title={runtime.image}>{runtime.image}</div>
                      <div
                        className="mt-1 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground/70"
                        title={sandboxVolumeName(runtime.sandbox.id)}
                      >
                        <HardDrive className="size-3 shrink-0" />
                        {compactVolumeName(runtime.sandbox.id)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {runtime.lastSyncedAt ? formatDateTime(runtime.lastSyncedAt, timeZone) : t('neverSynced')}
                    </td>
                    <td className="px-4 py-3">
                      <HermesRuntimeDialogLauncher
                        compact
                        runtime={{
                          name: runtime.sandbox.name,
                          agentId: runtime.agent.id,
                          deploymentId: runtime.sandbox.deploymentId,
                          dashboardUrl: runtime.dashboardUrl,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </DashboardTable>
          </DashboardSection>
        ) : null}

        <DashboardSection title={t('userSandboxes')} count={sandboxes.length}>
          {sandboxes.length === 0 ? (
            <DashboardEmptyState
              icon={Boxes}
              title={t('noUserSandboxesYet')}
              description={t('createALinuxSandboxThenAttachItToAnAgentFromTheAgentSettingsPage')}
            />
          ) : (
            <DashboardTable
              minWidth="54rem"
              headers={[
                { label: 'Sandbox' },
                { label: 'Mode' },
                { label: 'Status' },
                { label: 'Backing store' },
                { label: 'Agents' },
                { label: 'Created' },
                { label: 'Actions', align: 'right' },
              ]}
            >
              {sandboxes.map((s) => {
                const status = effectiveStatus(s.deploymentId, s.deployment.status);
                const running = status === 'running' || status === 'provisioning';
                const connector = connectorFromConfig(s.config);
                const disabledLegacy = s.kind === 'host' || s.kind === 'ssh' || (s.kind === 'connector' && !connector);
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          {s.kind === 'connector' ? <Laptop className="size-4" /> : <Terminal className="size-4" />}
                        </span>
                        <div>
                          <Link
                            href={`/app/${slug}/sandboxes/${s.id}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {s.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{s.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs font-medium text-muted-foreground">
                        {s.kind === 'connector' ? <Laptop className="size-3.5" /> : <Cpu className="size-3.5" />}
                        {modeLabel(s.kind)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={status} />
                    </td>
                    <td className="max-w-xs px-4 py-3 text-xs text-muted-foreground">
                      <div className="truncate">
                        {backingStore(s)}
                      </div>
                      <div className={`mt-0.5 text-[11px] text-muted-foreground/70 ${s.kind === 'connector' ? 'font-mono normal-case' : 'uppercase tracking-wide'}`}>
                        {s.kind === 'connector' ? connectorMeta(connector) : `network: ${s.network}`}
                      </div>
                      {s.kind === 'connector' && connector ? (
                        <div className="mt-1">
                          <SandboxConnectorStatus workspace={slug} sandboxId={s.id} />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{s._count.agentLinks}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(s.createdAt, timeZone)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link href={`/app/${slug}/sandboxes/${s.id}`} className={rowButton}>
                          {t('inspect')}
                        </Link>
                        {disabledLegacy ? null : running ? (
                          <>
                            <form action={stopSandboxAction}>
                              <input type="hidden" name="workspace" value={slug} />
                              <input type="hidden" name="sandboxId" value={s.id} />
                              <SubmitButton flash={false} pendingLabel={t('stopping')} className={rowButton}>
                                {t('stop')}
                              </SubmitButton>
                            </form>
                            <form action={restartSandboxAction}>
                              <input type="hidden" name="workspace" value={slug} />
                              <input type="hidden" name="sandboxId" value={s.id} />
                              <SubmitButton flash={false} pendingLabel={t('restarting')} className={rowButton}>
                                {t('restart')}
                              </SubmitButton>
                            </form>
                          </>
                        ) : (
                          <form action={startSandboxAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="sandboxId" value={s.id} />
                            <SubmitButton flash={false} pendingLabel={t('starting')} className={rowButton}>
                              {t('start')}
                            </SubmitButton>
                          </form>
                        )}
                        <form action={deleteSandboxAction}>
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="sandboxId" value={s.id} />
                          <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                            {t('delete')}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DashboardTable>
          )}
        </DashboardSection>

      </DashboardPage>
    </>
  );
}
