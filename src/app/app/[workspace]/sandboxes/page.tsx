/* DashboardTable consumes cell arrays as indexed values. */

import { AnimatedBadge } from "@/components/motion/animated-badge";

import { ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Bot, Boxes, Cpu, Laptop, Terminal } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { listSandboxes } from "@/lib/sandboxes/queries";
import {
  isExternalSandboxAccess,
  isExternalSandboxCandidate,
  isSessionSandbox,
} from "@/lib/sandboxes/external";
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
import { effectiveStatus } from "@/lib/process/supervisor";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { SandboxCreateForm } from "@/components/dashboard/sandboxes/SandboxCreateForm";
import { SandboxConnectorStatus } from "@/components/dashboard/sandboxes/SandboxConnectorStatus";
import { SandboxBatchTable } from "@/components/dashboard/sandboxes/SandboxBatchTable";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardSection,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";

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
      className={`rounded-xl border border-border bg-card px-4 py-3 ${className ?? ""}`}
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
    sshServer: {
      host: string;
      port: number;
      username: string;
      root: string;
    } | null;
  },
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (sandbox.kind === "connector") {
    const connector = connectorFromConfig(sandbox.config);
    return connector
      ? t("connectorBackingStore", { root: connector.remoteRoot })
      : t("connectorConfigMissing");
  }
  if (sandbox.kind === "ssh") {
    const server = sandbox.sshServer;
    if (!server) return t("legacySshDisabled");
    const host =
      server.host.includes(":") && !server.host.startsWith("[")
        ? `[${server.host}]`
        : server.host;
    return `${server.username}@${host}${server.port === 22 ? "" : `:${server.port}`} · ${server.root}`;
  }
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
  const scope = requestedScope === "external" ? "external" : "agents";
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");

  const sandboxes = await listSandboxes(ws.id);
  const anyProvisioning = sandboxes.some((s) => {
    const status = effectiveStatus(s.deploymentId, s.deployment.status);
    return (
      status === "provisioning" ||
      status === "copying" ||
      status === "restoring" ||
      status === "restore_cleanup_required" ||
      status === "upgrading"
    );
  });
  const ownSandboxes = sandboxes.filter(
    (sandbox) =>
      sandbox.agentLinks.length > 0 && !isSessionSandbox(sandbox.config),
  );
  const externalSandboxes = sandboxes.filter((sandbox) =>
    isExternalSandboxCandidate({
      kind: sandbox.kind,
      config: sandbox.config,
      isAgentTemplate: sandbox._count.agentLinks > 0,
    }),
  );
  const sessionSandboxes = sandboxes.filter((sandbox) =>
    isSessionSandbox(sandbox.config),
  );
  const externalLinkCount = externalSandboxes.reduce(
    (sum, sandbox) => sum + sandbox._count.externalAgentLinks,
    0,
  );
  const sandboxRows = (
    scope === "agents" ? ownSandboxes : externalSandboxes
  ).map((sandbox) => ({ sandbox }));
  const sectionTitle = t(
    scope === "agents" ? "agentOwnSandboxes" : "externalSandboxes",
  );
  const filters = [
    {
      value: "agents",
      label: t("agentOwnSandboxes"),
      href: `/app/${slug}/sandboxes`,
    },
    {
      value: "external",
      label: t("externalSandboxes"),
      href: `/app/${slug}/sandboxes?scope=external`,
    },
  ];

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title={t("sandboxes")} />
      <DashboardPage>
        <DashboardToolbar
          actions={<SandboxCreateForm workspace={slug} workspaceId={ws.id} />}
        >
          <p className="text-sm text-muted-foreground">
            {t("sandboxRolesDescription")}
          </p>
        </DashboardToolbar>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <SandboxStat
            label={t("agentOwnSandboxes")}
            value={ownSandboxes.length}
            icon={Bot}
          />
          <SandboxStat
            label={t("externalSandboxes")}
            value={externalSandboxes.length}
            icon={Laptop}
          />
          <SandboxStat
            label={t("sessionCopies")}
            value={sessionSandboxes.length}
            icon={Cpu}
          />
          <SandboxStat
            label={t("externalAgentLinks")}
            value={externalLinkCount}
            icon={Boxes}
          />
        </div>

        <DashboardSection
          title={sectionTitle}
          count={sandboxRows.length}
          actions={
            <div className="flex items-center gap-1 rounded-lg border border-border p-1">
              {filters.map((filter) => (
                <Link
                  key={filter.value}
                  href={filter.href}
                  aria-current={scope === filter.value ? "page" : undefined}
                  className={
                    scope === filter.value
                      ? "rounded-lg px-2 py-1 text-xs font-medium text-foreground bg-muted"
                      : "rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
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
                scope === "agents"
                  ? "ownSandboxesEmpty"
                  : "externalSandboxesEmpty",
              )}
            />
          ) : (
            <SandboxBatchTable
              key={scope}
              workspace={slug}
              minWidth="68rem"
              headers={[
                { label: t(scope === "agents" ? "ownerAgent" : "sandbox") },
                { label: t("mode") },
                { label: t("status") },
                { label: t("backingStore") },
                {
                  label: t(
                    scope === "agents" ? "sessionCopies" : "agentsColumn",
                  ),
                },
                { label: t("snapshots") },
                { label: t("created") },
                { label: t("actions"), align: "right" },
              ]}
              rows={sandboxRows.map((row) => {
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
                  (s.config &&
                    typeof s.config === "object" &&
                    !Array.isArray(s.config) &&
                    s.config.readOnly === true) ||
                  s.kind === "host" ||
                  (s.kind === "ssh" && !s.sshServer) ||
                  (s.kind === "connector" && !connector);
                const agent = s.agentLinks[0]?.agent;
                const copies =
                  scope === "agents"
                    ? sessionSandboxes.filter((copy) => {
                        const config = copy.config;
                        return (
                          config &&
                          typeof config === "object" &&
                          !Array.isArray(config) &&
                          (config.sourceSandboxId === s.id ||
                            (agent && config.agentId === agent.id))
                        );
                      })
                    : [];
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
                          <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            {s.kind === "connector" ? (
                              <Laptop className="size-4" />
                            ) : (
                              <Terminal className="size-4" />
                            )}
                          </span>
                          <div>
                            <div className="font-medium text-foreground">
                              {scope === "agents"
                                ? (agent?.name ?? s.name)
                                : s.name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {scope === "agents" ? s.name : s.slug}
                            </div>
                          </div>
                        </div>
                      </Link>
                    </div>,
                    <div key="mode" className="min-w-0">
                      <AnimatedBadge
                        status="neutral"
                        size="sm"
                        icon={
                          s.kind === "connector" ? (
                            <Laptop className="size-3.5" />
                          ) : (
                            <Cpu className="size-3.5" />
                          )
                        }
                      >
                        {modeLabel(s.kind, t)}
                      </AnimatedBadge>
                    </div>,
                    <div key="status" className="min-w-0">
                      <StatusBadge status={status} />
                    </div>,
                    <div key="storage" className="min-w-0 max-w-72">
                      <div
                        className="max-w-72 truncate"
                        title={s.image ?? backingStore(s, t)}
                      >
                        {backingStore(s, t).replace(
                          /(@sha256:[a-f0-9]{12})[a-f0-9]+/gi,
                          "$1…",
                        )}
                      </div>
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
                      {scope === "agents" ? (
                        copies.length > 0 ? (
                          <details className="max-w-64 text-xs">
                            <summary className="cursor-pointer rounded py-2 text-muted-foreground focus-visible:outline focus-visible:outline-ring">
                              {t("sessionCopyCount", { count: copies.length })}
                            </summary>
                            <ul className="max-h-64 space-y-2 overflow-y-auto py-2">
                              {copies.map((copy) => (
                                <li key={copy.id}>
                                  <Link
                                    href={`/app/${slug}/sandboxes/${copy.id}`}
                                    className="block truncate text-foreground hover:underline"
                                  >
                                    {copy.name}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )
                      ) : s.externalAgentLinks.length > 0 ? (
                        <ul className="space-y-1">
                          {s.externalAgentLinks.map((link) => (
                            <li key={link.agent.id}>
                              <ButtonLink
                                href={`/app/${slug}/agents/${link.agent.id}?settings=sandboxes`}
                                variant="ghost"
                                size="sm"
                              >
                                <Bot className="size-3.5" />
                                {link.agent.name}
                                <span className="text-xs text-muted-foreground">
                                  {isExternalSandboxAccess(link.access)
                                    ? t(`access.${link.access}`)
                                    : link.access}
                                </span>
                              </ButtonLink>
                            </li>
                          ))}
                        </ul>
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
