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
import { RemoteMcpPrivateHostsSettingsForm } from "@/components/admin/RemoteMcpPrivateHostsSettingsForm";
import { RuntimeSettingsForm } from "@/components/admin/RuntimeSettingsForm";
import { SkillImportSettingsForm } from "@/components/admin/SkillImportSettingsForm";
import {
  AGENT_CONCURRENCY_SETTING_KEY,
  getAgentConcurrencySettings,
  MAX_AGENT_CONCURRENCY,
  MAX_TOTAL_AGENT_CONCURRENCY,
  MCP_STARTUP_TIMEOUTS_SETTING_KEY,
  REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY,
  SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
  getSkillImportSettings,
  MAX_MCP_STARTUP_TIMEOUT_MS,
  MIN_MCP_STARTUP_TIMEOUT_MS,
  resolveMcpStartupTimeoutSettings,
  resolveRemoteMcpPrivateHostsSettings,
} from "@/lib/admin/settings";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireAdmin();
  const [
    t,
    attachmentLimit,
    skillImportSettings,
    mcpStartupTimeouts,
    remoteMcpPrivateHosts,
    agentConcurrency,
  ] = await Promise.all([
    getTranslations("admin"),
    resolveAgentAttachmentLimit(),
    getSkillImportSettings(),
    resolveMcpStartupTimeoutSettings(),
    resolveRemoteMcpPrivateHostsSettings(),
    getAgentConcurrencySettings(),
  ]);
  const [ops, locale, changes] = await Promise.all([
    getTranslations("adminOps"),
    getLocale(),
    getSettingChanges([
      AGENT_CONCURRENCY_SETTING_KEY,
      AGENT_ATTACHMENT_LIMIT_SETTING_KEY,
      MCP_STARTUP_TIMEOUTS_SETTING_KEY,
      REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY,
      SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
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

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={t("systemSettings")}
        description={t("systemSettingsDescription")}
      />
      <SettingsChanges>
        {section(
          AGENT_CONCURRENCY_SETTING_KEY,
          <AgentConcurrencySettingsForm
            {...agentConcurrency}
            perAgentLimit={MAX_AGENT_CONCURRENCY}
            totalLimit={MAX_TOTAL_AGENT_CONCURRENCY}
          />,
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
          REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY,
          <RemoteMcpPrivateHostsSettingsForm
            value={remoteMcpPrivateHosts.value}
            source={remoteMcpPrivateHosts.source}
          />,
        )}
        {section(
          SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
          <SkillImportSettingsForm maxSkills={skillImportSettings.maxSkills} />,
        )}
      </SettingsChanges>
    </AdminPage>
  );
}
