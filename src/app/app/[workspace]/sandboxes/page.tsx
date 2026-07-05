import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Boxes, Cpu, Laptop, Terminal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import {
  connectorFromConfig,
  defaultConnectorServerUrl,
  DEFAULT_CONNECTOR_REMOTE_ROOT,
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
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import { SandboxCreateForm } from '@/components/dashboard/sandboxes/SandboxCreateForm';
import { SandboxConnectorStatus } from '@/components/dashboard/sandboxes/SandboxConnectorStatus';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

const rowButton = 'text-xs text-muted-foreground transition-colors hover:text-foreground';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SandboxStat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Boxes;
}) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
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

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return defaultConnectorServerUrl();
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function SandboxesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const sandboxes = await listSandboxes(ws.id);
  const connectorServerUrl = await requestOrigin();
  const anyProvisioning = sandboxes.some((s) => effectiveStatus(s.deploymentId, s.deployment.status) === 'provisioning');
  const dockerCount = sandboxes.filter((s) => s.kind === 'docker').length;
  const connectorCount = sandboxes.filter((s) => s.kind === 'connector').length;
  const runningCount = sandboxes.filter((s) => {
    const status = effectiveStatus(s.deploymentId, s.deployment.status);
    return status === 'running' || status === 'provisioning';
  }).length;
  const agentLinkCount = sandboxes.reduce((sum, sandbox) => sum + sandbox._count.agentLinks, 0);

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title="Sandboxes" />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <SandboxCreateForm
              workspace={slug}
              connectorServerUrl={connectorServerUrl}
              defaultRemoteRoot={DEFAULT_CONNECTOR_REMOTE_ROOT}
            />
          }
        >
          <p className="text-sm text-muted-foreground">
            Docker Linux workspaces and user machines connected by one-command WebSocket agents.
          </p>
        </DashboardToolbar>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SandboxStat label="Docker" value={dockerCount} icon={Cpu} />
          <SandboxStat label="Connectors" value={connectorCount} icon={Laptop} />
          <SandboxStat label="Running" value={runningCount} icon={Terminal} />
          <SandboxStat label="Agent links" value={agentLinkCount} icon={Boxes} />
        </div>

        {sandboxes.length === 0 ? (
          <DashboardEmptyState
            icon={Boxes}
            title="No sandboxes yet"
            description="Create a Linux sandbox, then attach it to an agent from the agent settings page."
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
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(s.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`/app/${slug}/sandboxes/${s.id}`} className={rowButton}>
                        Inspect
                      </Link>
                      {disabledLegacy ? null : running ? (
                        <>
                          <form action={stopSandboxAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="sandboxId" value={s.id} />
                            <button className={rowButton}>Stop</button>
                          </form>
                          <form action={restartSandboxAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="sandboxId" value={s.id} />
                            <button className={rowButton}>Restart</button>
                          </form>
                        </>
                      ) : (
                        <form action={startSandboxAction}>
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="sandboxId" value={s.id} />
                          <button className={rowButton}>Start</button>
                        </form>
                      )}
                      <form action={deleteSandboxAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="sandboxId" value={s.id} />
                        <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DashboardTable>
        )}
      </DashboardPage>
    </>
  );
}
