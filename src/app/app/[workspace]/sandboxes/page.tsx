/* DashboardTable consumes cell arrays as indexed values. */

import { AnimatedBadge } from "@/components/motion/animated-badge";

import { ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Bot,
  Boxes,
  Container,
  Cpu,
  HardDrive,
  Laptop,
  Radio,
  Terminal,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  listManagedAgentRuntimes,
  listSandboxes,
} from "@/lib/sandboxes/queries";
import {
  connectorFromConfig,
  type SandboxConnectorConfig,
} from "@/lib/sandboxes/connector";
import {
  deleteSandboxAction,
  restartSandboxAction,
  startSandboxAction,
  stopSandboxAction,
} from "@/lib/sandboxes/actions";
import {
  DEFAULT_SANDBOX_IMAGE,
  findSandboxImageOption,
} from "@/lib/sandboxes/images";
import { sandboxVolumeName } from "@/lib/sandboxes/runtime";
import {
  readSandboxAllowSudo,
  readSandboxEnv,
  sandboxEnvToText,
} from "@/lib/sandboxes/env";
import { createHermesDashboardPath } from "@/lib/agents/hermes/token";
import { effectiveStatus } from "@/lib/process/supervisor";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { sshTargetIdFromConfig } from "@/lib/sandboxes/ssh-targets";
import { SshSandboxCreate } from "@/components/dashboard/sandboxes/SshSandboxCreate";
import { SandboxCreateForm } from "@/components/dashboard/sandboxes/SandboxCreateForm";
import { SandboxConnectorStatus } from "@/components/dashboard/sandboxes/SandboxConnectorStatus";
import { SandboxBatchTable } from "@/components/dashboard/sandboxes/SandboxBatchTable";
import { HermesRuntimeDialogLauncher } from "@/components/dashboard/agents/HermesRuntimeDialog";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardSection,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { getHermesArchiveSettings } from "@/lib/admin/settings";
import {
  HERMES_IMAGE_OPTIONS,
  resolveHermesImage,
} from "@/lib/agents/hermes/constants";

export const dynamic = "force-dynamic";

const LIFECYCLE_BLOCKED_STATUSES = new Set([
  "copying",
  "copy_failed",
  "restoring",
  "restore_failed",
  "restore_cleanup_required",
  "upgrading",
  "deleting",
]);

function formatDate(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(
    d,
    timeZone,
    { month: "short", day: "numeric", year: "numeric" },
    locale,
  );
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
    <div
      className={`rounded-md border border-border bg-card px-4 py-3 ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
}

function backingStore(
  sandbox: {
    kind: string;
    image: string | null;
    config: unknown;
    hostRoot?: string | null;
  },
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (sandbox.kind === "connector") {
    const connector = connectorFromConfig(sandbox.config);
    return connector
      ? t("connectorBackingStore", { root: connector.remoteRoot })
      : t("connectorConfigMissing");
  }
  if (sandbox.kind === "ssh")
    return sshTargetIdFromConfig(sandbox.config) ?? t("legacySshDisabled");
  if (sandbox.kind === "host") return t("legacyHostDisabled");
  const image = sandbox.image ?? DEFAULT_SANDBOX_IMAGE;
  const option = findSandboxImageOption(image);
  return option ? option.name : image;
}

function modeLabel(
  kind: string,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (kind === "connector") return t("connectorMode");
  if (kind === "ssh") return t("sshMode");
  if (kind === "host") return t("disabledHostMode");
  return t("docker");
}

function connectorMeta(
  connector: SandboxConnectorConfig | null,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (!connector) return t("waitingForConfig");
  return t("openSandboxToGenerateCommand");
}

function isImportedHermesArchive(config: unknown): boolean {
  return Boolean(
    config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      (config as { importSource?: unknown }).importSource === "hermes-archive",
  );
}

export default async function SandboxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const t = await getTranslations("console.sandboxes");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const [{ workspace: slug }, { scope: requestedScope }] = await Promise.all([
    params,
    searchParams,
  ]);
  const scope =
    requestedScope === "agents" || requestedScope === "users"
      ? requestedScope
      : "all";
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const hermesImages = [resolveHermesImage(undefined), ...HERMES_IMAGE_OPTIONS];

  const [sandboxes, rawManagedRuntimes, systemSettings] = await Promise.all([
    listSandboxes(ws.id),
    listManagedAgentRuntimes(ws.id),
    getHermesArchiveSettings(),
  ]);
  const managedRuntimes = rawManagedRuntimes.map((runtime) => ({
    ...runtime,
    dashboardUrl: createHermesDashboardPath(runtime.id),
  }));
  const managedStatus = (runtime: (typeof managedRuntimes)[number]) =>
    runtime.status === "error" || runtime.status === "setup_required"
      ? runtime.status
      : effectiveStatus(
          runtime.sandbox.deploymentId,
          runtime.sandbox.deployment.status,
        );
  const managedRuntimeDialogData = (
    runtime: (typeof managedRuntimes)[number],
    status: string,
  ) => ({
    name: runtime.sandbox.name,
    agentId: runtime.agent.id,
    deploymentId: runtime.sandbox.deploymentId,
    dashboardUrl: runtime.dashboardUrl,
    management: {
      workspace: slug,
      sandboxId: runtime.sandbox.id,
      sandboxName: runtime.sandbox.name,
      environment: sandboxEnvToText(readSandboxEnv(runtime.sandbox.config)),
      allowSudo: readSandboxAllowSudo(runtime.sandbox.config),
      status,
      snapshots: runtime.sandbox.snapshots.map((snapshot) => ({
        id: snapshot.id,
        name: snapshot.name,
        status: snapshot.status,
        error: snapshot.error ? "error" : null,
        createdAt: formatInTimeZone(
          snapshot.createdAt,
          timeZone,
          {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          },
          locale,
        ),
      })),
    },
  });
  const anyProvisioning =
    sandboxes.some((s) => {
      const status = effectiveStatus(s.deploymentId, s.deployment.status);
      return (
        status === "provisioning" ||
        status === "copying" ||
        status === "restoring" ||
        status === "restore_cleanup_required" ||
        status === "upgrading"
      );
    }) ||
    managedRuntimes.some((runtime) => {
      const status = managedStatus(runtime);
      return (
        status === "provisioning" ||
        status === "copying" ||
        status === "restoring" ||
        status === "restore_cleanup_required" ||
        status === "upgrading"
      );
    });
  const dockerCount = sandboxes.filter((s) => s.kind === "docker").length;
  const connectorCount = sandboxes.filter((s) => s.kind === "connector").length;
  const runningCount =
    sandboxes.filter((s) => {
      const status = effectiveStatus(s.deploymentId, s.deployment.status);
      return status === "running" || status === "provisioning";
    }).length +
    managedRuntimes.filter((runtime) => {
      const status = managedStatus(runtime);
      return status === "running" || status === "provisioning";
    }).length;
  const agentLinkCount =
    sandboxes.reduce((sum, sandbox) => sum + sandbox._count.agentLinks, 0) +
    managedRuntimes.length;
  const allSandboxRows = [
    ...sandboxes.map((sandbox) => ({
      type: "sandbox" as const,
      createdAt: sandbox.createdAt,
      sandbox,
    })),
    ...managedRuntimes.map((runtime) => ({
      type: "hermes" as const,
      createdAt: runtime.sandbox.createdAt,
      runtime,
    })),
  ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const sandboxRows = allSandboxRows.filter((row) => {
    if (scope === "all") return true;
    if (row.type === "hermes") return scope === "agents";
    return scope === "agents"
      ? row.sandbox.agentLinks.length > 0
      : row.sandbox.agentLinks.length === 0;
  });
  const sectionTitle =
    scope === "agents"
      ? t("agentSandboxes")
      : scope === "users"
        ? t("userCreatedSandboxes")
        : t("sandboxes");
  const filters = [
    { value: "all", label: t("sandboxes"), href: `/app/${slug}/sandboxes` },
    {
      value: "agents",
      label: t("agentSandboxes"),
      href: `/app/${slug}/sandboxes?scope=agents`,
    },
    {
      value: "users",
      label: t("userCreatedSandboxes"),
      href: `/app/${slug}/sandboxes?scope=users`,
    },
  ];

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title={t("sandboxes")} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <div className="flex flex-wrap items-start gap-2">
              <SshSandboxCreate workspaceId={ws.id} />
              <SandboxCreateForm
                workspace={slug}
                hermesArchiveMaxUploadMiB={
                  systemSettings.hermesArchiveMaxUploadMiB
                }
                hermesImages={hermesImages}
              />
            </div>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t(
              "dockerLinuxWorkspacesAndUserMachinesConnectedByOnecommandWebsocketAgents",
            )}
          </p>
        </DashboardToolbar>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <SandboxStat label={t("docker")} value={dockerCount} icon={Cpu} />
          <SandboxStat
            label={t("connectors")}
            value={connectorCount}
            icon={Laptop}
          />
          <SandboxStat
            label={t("hermes")}
            value={managedRuntimes.length}
            icon={Container}
          />
          <SandboxStat
            label={t("running")}
            value={runningCount}
            icon={Terminal}
          />
          <SandboxStat
            label={t("agentLinks")}
            value={agentLinkCount}
            icon={Boxes}
            className="col-span-2 xl:col-span-1"
          />
        </div>

        <DashboardSection
          title={sectionTitle}
          count={sandboxRows.length}
          actions={
            <div className="flex items-center gap-1 rounded-md border border-border p-1">
              {filters.map((filter) => (
                <Link
                  key={filter.value}
                  href={filter.href}
                  aria-current={scope === filter.value ? "page" : undefined}
                  className={
                    scope === filter.value
                      ? "rounded px-2 py-1 text-xs font-medium text-foreground bg-muted"
                      : "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  }
                >
                  {filter.label}
                </Link>
              ))}
            </div>
          }
        >
          {sandboxRows.length === 0 ? (
            <DashboardEmptyState
              icon={Boxes}
              title={t("noSandboxesYet")}
              description={t(
                "createALinuxSandboxThenAttachItToAnAgentFromTheAgentSettingsPage",
              )}
            />
          ) : (
            <SandboxBatchTable
              key={scope}
              workspace={slug}
              minWidth="68rem"
              headers={[
                { label: t("sandbox") },
                { label: t("mode") },
                { label: t("status") },
                { label: t("backingStore") },
                { label: t("agentsColumn") },
                { label: t("snapshots") },
                { label: t("created") },
                { label: t("actions"), align: "right" },
              ]}
              rows={sandboxRows.map((row) => {
                if (row.type === "hermes") {
                  const runtime = row.runtime;
                  const status = managedStatus(runtime);
                  const running =
                    status === "running" || status === "provisioning";
                  const lifecycleBlocked =
                    LIFECYCLE_BLOCKED_STATUSES.has(status);
                  const imported = isImportedHermesArchive(
                    runtime.sandbox.config,
                  );
                  return {
                    id: runtime.sandbox.id,
                    name: runtime.sandbox.name,
                    batchEligible:
                      !lifecycleBlocked && status !== "provisioning",
                    cells: [
                      <div key="name" className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/35 text-(--color-warning) dark:text-(--color-warning)">
                            <Container className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">
                              {runtime.sandbox.name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {runtime.sandbox.slug}
                              {imported
                                ? ` · ${t("importedHermesArchiveLabel")}`
                                : ""}
                            </div>
                          </div>
                        </div>
                      </div>,
                      <div key="mode" className="min-w-0">
                        <AnimatedBadge status="neutral" size="sm">
                          <Container className="size-3.5" />
                          {t("hermes")}
                        </AnimatedBadge>
                      </div>,
                      <div key="status" className="min-w-0">
                        <StatusBadge status={status} />
                        {runtime.lastError ? (
                          <div
                            className="mt-1 max-w-48 truncate text-xs text-destructive"
                            title={runtime.lastError}
                          >
                            {runtime.lastError}
                          </div>
                        ) : null}
                      </div>,
                      <div key="storage" className="min-w-0">
                        <div className="truncate" title={runtime.image}>
                          {runtime.image}
                        </div>
                        <div
                          className="mt-1 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground/70"
                          title={sandboxVolumeName(runtime.sandbox.id)}
                        >
                          <HardDrive className="size-3 shrink-0" />
                          {compactVolumeName(runtime.sandbox.id)}
                        </div>
                      </div>,
                      <div key="agent" className="min-w-0">
                        <ButtonLink
                          href={`/app/${slug}/agents/${runtime.agent.id}`}
                          variant="ghost"
                          size="sm"
                        >
                          <Bot className="size-3.5 text-muted-foreground" />
                          {runtime.agent.name}
                        </ButtonLink>
                      </div>,
                      <div key="snapshots" className="min-w-0">
                        {runtime.sandbox.snapshots.length}
                      </div>,
                      <div key="created" className="min-w-0">
                        {formatDate(
                          runtime.sandbox.createdAt,
                          timeZone,
                          locale,
                        )}
                      </div>,
                      <div key="actions" className="min-w-0">
                        <div className="flex items-center justify-end gap-3">
                          <HermesRuntimeDialogLauncher
                            compact
                            runtime={managedRuntimeDialogData(runtime, status)}
                          />
                          <ButtonLink
                            href={`/app/${slug}/agents/${runtime.agent.id}?settings=channels`}
                            title={t("channels")}
                            aria-label={t("channels")}
                            variant="ghost"
                            size="icon"
                          >
                            <Radio className="size-4" />
                          </ButtonLink>
                          {!lifecycleBlocked ? (
                            running ? (
                              <form action={stopSandboxAction}>
                                <input
                                  type="hidden"
                                  name="workspace"
                                  value={slug}
                                />
                                <input
                                  type="hidden"
                                  name="sandboxId"
                                  value={runtime.sandbox.id}
                                />
                                <SubmitButton
                                  flash={false}
                                  pendingLabel={t("stopping")}
                                  variant="ghost"
                                  size="sm"
                                >
                                  {t("stop")}
                                </SubmitButton>
                              </form>
                            ) : (
                              <form action={startSandboxAction}>
                                <input
                                  type="hidden"
                                  name="workspace"
                                  value={slug}
                                />
                                <input
                                  type="hidden"
                                  name="sandboxId"
                                  value={runtime.sandbox.id}
                                />
                                <SubmitButton
                                  flash={false}
                                  pendingLabel={t("starting")}
                                  variant="ghost"
                                  size="sm"
                                >
                                  {t("start")}
                                </SubmitButton>
                              </form>
                            )
                          ) : null}
                        </div>
                      </div>,
                    ],
                  };
                }

                const s = row.sandbox;
                const status = effectiveStatus(
                  s.deploymentId,
                  s.deployment.status,
                );
                const running =
                  status === "running" || status === "provisioning";
                const lifecycleBlocked = LIFECYCLE_BLOCKED_STATUSES.has(status);
                const connector = connectorFromConfig(s.config);
                const disabledLegacy =
                  s.kind === "host" ||
                  (s.kind === "ssh" && !sshTargetIdFromConfig(s.config)) ||
                  (s.kind === "connector" && !connector);
                const agent = s.agentLinks[0]?.agent;
                return {
                  id: s.id,
                  name: s.name,
                  batchEligible:
                    !disabledLegacy &&
                    !lifecycleBlocked &&
                    status !== "provisioning",
                  cells: [
                    <div key="name" className="min-w-0">
                      <Link
                        href={`/app/${slug}/sandboxes/${s.id}`}
                        className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            {s.kind === "connector" ? (
                              <Laptop className="size-4" />
                            ) : (
                              <Terminal className="size-4" />
                            )}
                          </span>
                          <div>
                            <div className="font-medium text-foreground">
                              {s.name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {s.slug}
                            </div>
                          </div>
                        </div>
                      </Link>
                    </div>,
                    <div key="mode" className="min-w-0">
                      <AnimatedBadge status="neutral" size="sm">
                        {s.kind === "connector" ? (
                          <Laptop className="size-3.5" />
                        ) : (
                          <Cpu className="size-3.5" />
                        )}
                        {modeLabel(s.kind, t)}
                      </AnimatedBadge>
                    </div>,
                    <div key="status" className="min-w-0">
                      <StatusBadge status={status} />
                    </div>,
                    <div key="storage" className="min-w-0">
                      <div className="truncate">{backingStore(s, t)}</div>
                      <div
                        className={`mt-0.5 text-[11px] text-muted-foreground/70 ${s.kind === "connector" ? "font-mono normal-case" : "uppercase tracking-wide"}`}
                      >
                        {s.kind === "connector"
                          ? connectorMeta(connector, t)
                          : t("networkValue", { network: s.network })}
                      </div>
                      {s.kind === "connector" && connector ? (
                        <div className="mt-1">
                          <SandboxConnectorStatus
                            workspace={slug}
                            sandboxId={s.id}
                          />
                        </div>
                      ) : null}
                    </div>,
                    <div key="agent" className="min-w-0">
                      {agent ? (
                        <ButtonLink
                          href={`/app/${slug}/agents/${agent.id}`}
                          variant="ghost"
                          size="sm"
                        >
                          <Bot className="size-3.5 text-muted-foreground" />
                          {agent.name}
                        </ButtonLink>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>,
                    <div key="snapshots" className="min-w-0">
                      {s._count.snapshots}
                    </div>,
                    <div key="created" className="min-w-0">
                      {formatDate(s.createdAt, timeZone, locale)}
                    </div>,
                    <div key="actions" className="min-w-0">
                      <div className="flex items-center justify-end gap-3">
                        {disabledLegacy || lifecycleBlocked ? null : running ? (
                          <>
                            <form action={stopSandboxAction}>
                              <input
                                type="hidden"
                                name="workspace"
                                value={slug}
                              />
                              <input
                                type="hidden"
                                name="sandboxId"
                                value={s.id}
                              />
                              <SubmitButton
                                flash={false}
                                pendingLabel={t("stopping")}
                                variant="ghost"
                                size="sm"
                              >
                                {t("stop")}
                              </SubmitButton>
                            </form>
                            <form action={restartSandboxAction}>
                              <input
                                type="hidden"
                                name="workspace"
                                value={slug}
                              />
                              <input
                                type="hidden"
                                name="sandboxId"
                                value={s.id}
                              />
                              <SubmitButton
                                flash={false}
                                pendingLabel={t("restarting")}
                                variant="ghost"
                                size="sm"
                              >
                                {t("restart")}
                              </SubmitButton>
                            </form>
                          </>
                        ) : (
                          <form action={startSandboxAction}>
                            <input
                              type="hidden"
                              name="workspace"
                              value={slug}
                            />
                            <input
                              type="hidden"
                              name="sandboxId"
                              value={s.id}
                            />
                            <SubmitButton
                              flash={false}
                              pendingLabel={t("starting")}
                              variant="ghost"
                              size="sm"
                            >
                              {t("start")}
                            </SubmitButton>
                          </form>
                        )}
                        {agent ? (
                          <ButtonLink
                            href={`/app/${slug}/agents/${agent.id}`}
                            variant="ghost"
                            size="sm"
                          >
                            {t("openAgent")}
                          </ButtonLink>
                        ) : (
                          <form action={deleteSandboxAction}>
                            <input
                              type="hidden"
                              name="workspace"
                              value={slug}
                            />
                            <input
                              type="hidden"
                              name="sandboxId"
                              value={s.id}
                            />
                            <ConfirmSubmitButton
                              triggerLabel={t("delete")}
                              confirmLabel={common("confirm")}
                              cancelLabel={common("cancel")}
                              prompt={t("deleteSandboxShortPrompt", {
                                name: s.name,
                              })}
                              pendingLabel={t("deletingSandbox")}
                              promptClassName="max-w-36 text-right text-xs text-muted-foreground"
                            />
                          </form>
                        )}
                      </div>
                    </div>,
                  ],
                };
              })}
            />
          )}
        </DashboardSection>
      </DashboardPage>
    </>
  );
}
