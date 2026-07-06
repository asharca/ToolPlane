import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { Cpu, Laptop, Terminal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getSandbox } from '@/lib/sandboxes/queries';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';
import {
  connectorClientCommand,
  connectorFromConfig,
  type SandboxConnectorConfig,
} from '@/lib/sandboxes/connector';
import {
  deleteSandboxAction,
  generateConnectorCommandAction,
  renameSandboxAction,
  restartSandboxAction,
  startSandboxAction,
  stopSandboxAction,
} from '@/lib/sandboxes/actions';
import { effectiveStatus } from '@/lib/process/supervisor';
import { mcpRpc } from '@/lib/process/mcp-client';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { DashboardPage, DashboardPanel } from '@/components/dashboard/DashboardUI';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';

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

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
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
  searchParams,
}: {
  params: Promise<{ workspace: string; sandboxId: string }>;
  searchParams?: Promise<{ token?: string }>;
}) {
  const { workspace: slug, sandboxId } = await params;
  const token = (await searchParams)?.token?.trim();
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const sandbox = await getSandbox(ws.id, sandboxId);
  if (!sandbox) notFound();

  const status = effectiveStatus(sandbox.deploymentId, sandbox.deployment.status);
  const running = status === 'running' || status === 'provisioning';
  const connector = connectorFromConfig(sandbox.config);
  const disabledLegacy = sandbox.kind === 'host' || sandbox.kind === 'ssh' || (sandbox.kind === 'connector' && !connector);
  const canUseConsole = status === 'running' && !disabledLegacy;
  const initialDirectory =
    canUseConsole
      ? parseInitialDirectory(
          await mcpRpc(
            sandbox.deploymentId,
            'tools/call',
            { name: 'list_dir', arguments: { path: '.' } },
            5000,
          ),
        )
      : { path: '.', entries: [] };

  return (
    <>
      <ProvisioningRefresher active={status === 'provisioning'} />
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
                <form action={renameSandboxAction} className="mt-2 flex max-w-md items-center gap-2">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="sandboxId" value={sandbox.id} />
                  <input
                    name="name"
                    defaultValue={sandbox.name}
                    maxLength={80}
                    className="ui-input h-8 min-w-0 text-sm"
                    aria-label="Sandbox name"
                  />
                  <SubmitButton pendingLabel="Renaming…" className="ui-button-secondary h-8 text-xs">
                    Rename
                  </SubmitButton>
                </form>
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
                  <span>{sandbox.agentLinks.length} agent(s)</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={status} />
              <Link href={`/app/${slug}/agents`} className={rowButton}>
                Attach to agent
              </Link>
              {disabledLegacy ? null : running ? (
                <>
                  <form action={stopSandboxAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="sandboxId" value={sandbox.id} />
                    <SubmitButton flash={false} pendingLabel="Stopping…" className={rowButton}>
                      Stop
                    </SubmitButton>
                  </form>
                  <form action={restartSandboxAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="sandboxId" value={sandbox.id} />
                    <SubmitButton flash={false} pendingLabel="Restarting…" className={rowButton}>
                      Restart
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <form action={startSandboxAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="sandboxId" value={sandbox.id} />
                  <SubmitButton flash={false} pendingLabel="Starting…" className={rowButton}>
                    Start
                  </SubmitButton>
                </form>
              )}
              <form action={deleteSandboxAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="sandboxId" value={sandbox.id} />
                <button className="text-xs text-red-600 transition-colors hover:text-red-700 dark:text-red-400 dark:hover:text-red-300">Delete</button>
              </form>
            </div>
          </div>

          {sandbox.agentLinks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Attached agents:</span>
              {sandbox.agentLinks.map((link) => (
                <Link key={link.agent.id} href={`/app/${slug}/agents/${link.agent.id}`} className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted">
                  {link.agent.name}
                </Link>
              ))}
            </div>
          ) : null}

          {status === 'provisioning' ? (
            <div className="rounded-lg border border-brand/25 bg-brand-soft px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Preparing {sandbox.kind === 'connector' ? 'connector sandbox' : 'Linux sandbox'}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {sandbox.kind === 'connector'
                      ? 'ToolPlane is waiting for the connector session to come online and will refresh automatically.'
                      : 'ToolPlane is creating the runtime, attaching storage, and waiting for the MCP endpoint to become ready.'}
                  </p>
                </div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">auto-refreshing</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
              </div>
            </div>
          ) : null}

          {sandbox.kind === 'connector' && connector ? (
            <DashboardPanel
              title="Connector setup"
              description="Run this command on the user machine. The client connects back to the platform over WebSocket and executes sandbox operations locally."
            >
              <div className="grid gap-4 lg:grid-cols-2">
                {token ? (
                  <CommandBlock label="Run on the user machine" command={connectorClientCommand(connector, token)} />
                ) : (
                  <div className="rounded-md border border-border bg-background px-3 py-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Run on the user machine
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Generate a fresh connection command to mint a token for this sandbox.
                    </p>
                    <form action={generateConnectorCommandAction} className="mt-3">
                      <input type="hidden" name="workspace" value={slug} />
                      <input type="hidden" name="sandboxId" value={sandbox.id} />
                      <SubmitButton pendingLabel="Generating…" className="ui-button-primary text-sm">
                        Generate command
                      </SubmitButton>
                    </form>
                  </div>
                )}
                <div className="rounded-md border border-border bg-muted/35 px-3 py-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">Connection model</div>
                  <p className="mt-1">
                    The platform does not dial the user machine. The connector CLI opens a WebSocket session to <span className="font-mono text-foreground">{connector.serverUrl}</span>, then exposes <span className="font-mono text-foreground">{connector.remoteRoot}</span> as this sandbox root.
                  </p>
                  {token ? (
                    <p className="mt-2 text-foreground">
                      This generated token is shown only in this URL. Keep the command somewhere safe before leaving the page.
                    </p>
                  ) : (
                    <p className="mt-2">
                      Tokens are generated server-side and stored only as hashes.
                    </p>
                  )}
                </div>
              </div>
            </DashboardPanel>
          ) : null}

          <SandboxConsole
            deploymentId={sandbox.deploymentId}
            running={canUseConsole}
            initialPath={initialDirectory.path}
            initialEntries={initialDirectory.entries}
          />
        </section>
      </DashboardPage>
    </>
  );
}
