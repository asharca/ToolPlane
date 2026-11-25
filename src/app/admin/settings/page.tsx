import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";
import { SettingsChanges } from "@/components/admin/SettingsChanges";
import { getSettingChanges } from "@/lib/admin/audited-setting";
import { adminHref } from "@/lib/admin/navigation";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { requireAdmin } from "@/lib/auth/admin";
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  AGENT_ATTACHMENT_LIMIT_SETTING_KEY,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resolveAgentAttachmentLimit,
} from "@/lib/agents/attachment-limits";
import { AdminPage, AdminPageHeader } from "@/components/admin/AdminUI";
import { McpRuntimeSettingsForm } from "@/components/admin/McpRuntimeSettingsForm";
import { AgentConcurrencySettingsForm } from "@/components/admin/AgentConcurrencySettingsForm";
import { AgentSandboxAutoStopSettingsForm } from "@/components/admin/AgentSandboxAutoStopSettingsForm";
import { PrivateHostsSettingsForm } from "@/components/admin/PrivateHostsSettingsForm";
import { RuntimeSettingsForm } from "@/components/admin/RuntimeSettingsForm";
import { SkillImportSettingsForm } from "@/components/admin/SkillImportSettingsForm";
import { TransportSettingsForm } from "@/components/admin/TransportSettingsForm";
import { UserLimitsSettingsForm } from "@/components/admin/UserLimitsSettingsForm";
import { McpOAuthClientsSettings } from "@/components/admin/McpOAuthClientsSettings";
import { getMcpOAuthAdminOverview } from "@/lib/admin/mcp-oauth-clients";
import { getUserLimitDefaults } from "@/lib/storage/user-quota";
import { LogSettings } from "@/components/admin/LogSettings";
import { getLogSettings, LOG_SETTINGS_KEY } from "@/lib/observability/settings";
import {
  TRANSPORT_SETTINGS_KEY,
  getTransportSettings,
} from "@/lib/admin/transport-settings";
import {
  AGENT_CONCURRENCY_SETTING_KEY,
  getAgentConcurrencySettings,
  AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
  getAgentSandboxAutoStopSettings,
  MAX_AGENT_CONCURRENCY,
  MAX_TOTAL_AGENT_CONCURRENCY,
  MCP_STARTUP_TIMEOUTS_SETTING_KEY,
  PRIVATE_HOSTS_SETTING_KEY,
  SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
  getSkillImportSettings,
  MAX_MCP_STARTUP_TIMEOUT_MS,
  MIN_MCP_STARTUP_TIMEOUT_MS,
  resolveMcpStartupTimeoutSettings,
  resolvePrivateHostsSettings,
} from "@/lib/admin/settings";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireAdmin();
  const [
    t,
    attachmentLimit,
    skillImportSettings,
    mcpStartupTimeouts,
    privateHosts,
    agentConcurrency,
    agentSandboxAutoStop,
    transportSettings,
    userLimitDefaults,
    logSettings,
    mcpOAuthOverview,
  ] = await Promise.all([
    getTranslations("admin"),
    resolveAgentAttachmentLimit(),
    getSkillImportSettings(),
    resolveMcpStartupTimeoutSettings(),
    resolvePrivateHostsSettings(),
    getAgentConcurrencySettings(),
    getAgentSandboxAutoStopSettings(),
    getTransportSettings(),
    getUserLimitDefaults(),
    getLogSettings(),
    getMcpOAuthAdminOverview(),
  ]);
  const [ops, locale, changes] = await Promise.all([
    getTranslations("adminOps"),
    getLocale(),
    getSettingChanges([
      AGENT_CONCURRENCY_SETTING_KEY,
      AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
      AGENT_ATTACHMENT_LIMIT_SETTING_KEY,
      MCP_STARTUP_TIMEOUTS_SETTING_KEY,
      PRIVATE_HOSTS_SETTING_KEY,
      SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
      TRANSPORT_SETTINGS_KEY,
      "user.limits",
      LOG_SETTINGS_KEY,
    ]),
  ]);
  const section = (key: string, children: ReactNode) => {
    const change = changes.get(key);
    return (
      <section key={key} className="space-y-2">
        <div key={change?.id ?? "initial"}>{children}</div>
        <p className="text-xs text-muted-foreground">
          {change ? (
            <Link
              href={adminHref("/admin/logs", {
                tab: "audit",
                targetType: "systemSetting",
                targetId: key,
                returnTo: "/admin/settings",
              })}
              className="hover:underline"
            >
              {ops("lastModified", {
                name: change.actor,
                time: formatInTimeZone(
                  change.createdAt,
                  resolveUserTimeZone(admin),
                  { dateStyle: "medium", timeStyle: "short" },
                  locale,
                ),
              })}
            </Link>
          ) : (
            ops("noModification")
          )}
        </p>
      </section>
    );
  };
  const observedAt = Date.now();

  const navSections = [
    { id: "user-limits", label: t("userLimitDefaults") },
    { id: "agent-execution", label: t("settingsAgentExecution") },
    { id: "mcp-runtime", label: t("settingsMcpRuntime") },
    { id: "transport", label: t("settingsTransport") },
    { id: "log-settings", label: t("logsSettings") },
    { id: "mcp-oauth", label: t("mcpOAuthClients") },
  ];

  return (
    <AdminPage className="max-w-6xl">
      <AdminPageHeader title={t("systemSettings")} />
      <div className="grid items-start gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label={t("systemSettings")}
          className="flex gap-1 overflow-x-auto border-b border-border pb-2 lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0"
        >
          {navSections.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:text-sm"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="min-w-0 space-y-6">
          <SettingsChanges>
            <div id="user-limits" className="scroll-mt-6">
              {section(
                "user.limits",
                <UserLimitsSettingsForm defaults={userLimitDefaults} />,
              )}
            </div>
            <fieldset
              id="agent-execution"
              className="min-w-0 scroll-mt-6 space-y-6"
            >
              <legend className="mb-1 text-base font-semibold">
                {t("settingsAgentExecution")}
              </legend>
              {section(
                AGENT_CONCURRENCY_SETTING_KEY,
                <AgentConcurrencySettingsForm
                  {...agentConcurrency}
                  perAgentLimit={MAX_AGENT_CONCURRENCY}
                  totalLimit={MAX_TOTAL_AGENT_CONCURRENCY}
                />,
              )}
              {section(
                AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
                <AgentSandboxAutoStopSettingsForm {...agentSandboxAutoStop} />,
              )}
              {section(
                AGENT_ATTACHMENT_LIMIT_SETTING_KEY,
                <RuntimeSettingsForm
                  bytes={attachmentLimit.bytes}
                  source={attachmentLimit.source}
                  cached={attachmentLimit.cached}
                  minMegabytes={MIN_ADMIN_ATTACHMENT_MEGABYTES}
                  maxMegabytes={MAX_ADMIN_ATTACHMENT_MEGABYTES}
                />,
              )}
            </fieldset>
            <fieldset
              id="mcp-runtime"
              className="min-w-0 scroll-mt-6 space-y-6"
            >
              <legend className="mb-1 text-base font-semibold">
                {t("settingsMcpRuntime")}
              </legend>
              {section(
                MCP_STARTUP_TIMEOUTS_SETTING_KEY,
                <McpRuntimeSettingsForm
                  idleTimeoutMs={mcpStartupTimeouts.idleTimeoutMs}
                  maxTimeoutMs={mcpStartupTimeouts.maxTimeoutMs}
                  source={mcpStartupTimeouts.source}
                  minTimeoutSeconds={MIN_MCP_STARTUP_TIMEOUT_MS / 1_000}
                  maxTimeoutSeconds={MAX_MCP_STARTUP_TIMEOUT_MS / 1_000}
                />,
              )}
              {section(
                PRIVATE_HOSTS_SETTING_KEY,
                <PrivateHostsSettingsForm
                  value={privateHosts.value}
                  source={privateHosts.source}
                />,
              )}
            </fieldset>
            <fieldset id="transport" className="min-w-0 scroll-mt-6 space-y-6">
              <legend className="mb-1 text-base font-semibold">
                {t("settingsTransport")}
              </legend>
              {section(
                TRANSPORT_SETTINGS_KEY,
                <TransportSettingsForm
                  allowHttp={transportSettings.allowHttp}
                  a2aInlineBytes={transportSettings.a2aInlineBytes}
                  a2aTaskFiles={transportSettings.a2aTaskFiles}
                  source={transportSettings.source}
                />,
              )}
              {section(
                SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
                <SkillImportSettingsForm
                  maxSkills={skillImportSettings.maxSkills}
                />,
              )}
            </fieldset>
            <div id="log-settings" className="scroll-mt-6">
              {section(
                LOG_SETTINGS_KEY,
                <LogSettings
                  settings={{
                    ...logSettings,
                    captures: logSettings.captures.filter(
                      (item) => new Date(item.expiresAt).getTime() > observedAt,
                    ),
                  }}
                />,
              )}
            </div>
          </SettingsChanges>
          <div id="mcp-oauth" className="scroll-mt-6">
            <McpOAuthClientsSettings overview={mcpOAuthOverview} />
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
