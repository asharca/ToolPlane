import { ModalSidebarLayout } from "./ModalSidebarLayout";

import { getLocale, getTranslations } from "next-intl/server";

import { KeyRound, LockKeyhole, Settings } from "lucide-react";
import { listApiTokens } from "@/lib/auth/tokens";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { TimeZoneSettings } from "@/components/timezone/TimeZoneSettings";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ChangePasswordForm } from "@/components/auth/PasswordRecoveryForms";
import { DashboardPanel } from "./DashboardUI";
import { TokenManager } from "./TokenManager";
import type { WorkspaceAccountUser } from "./WorkspaceAccountPage";

export type PersonalSettingsSection = "preferences" | "security" | "tokens";
export async function PersonalSettingsContent({
  user,
  section = "preferences",
}: {
  user: WorkspaceAccountUser;
  section?: PersonalSettingsSection;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("console.settings"),
    getLocale(),
  ]);
  const workspacesT = await getTranslations("console.workspaces");
  const tokens = await listApiTokens(user.id);
  const timeZone = resolveUserTimeZone(user);
  const date = (value: Date | null) =>
    value
      ? formatInTimeZone(value, timeZone, { dateStyle: "medium" }, locale)
      : null;

  const sections = [
    {
      id: "preferences",
      label: t("preferences"),
      icon: <Settings className="size-4" />,
      content: (
        <div className="space-y-6 p-5 sm:p-6 lg:p-8">
          <p className="text-sm text-muted-foreground">
            {workspacesT("accountHint")}
          </p>
          <DashboardPanel title={t("preferences")}>
            <div className="space-y-5">
              <p className="break-all text-sm">{user.email}</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{t("language")}</span>
                <LocaleSwitcher />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>{workspacesT("appearance")}</span>
                <ThemeToggle />
              </div>
              <TimeZoneSettings timeZoneOverride={user.timeZoneOverride} />
            </div>
          </DashboardPanel>
        </div>
      ),
    },
    {
      id: "security",
      label: t("security"),
      icon: <LockKeyhole className="size-4" />,
      content: (
        <div className="space-y-6 p-5 sm:p-6 lg:p-8">
          <p className="text-sm text-muted-foreground">
            {workspacesT("accountHint")}
          </p>
          <DashboardPanel
            title={t("security")}
            description={t("passwordSettingsDesc")}
          >
            <ChangePasswordForm />
          </DashboardPanel>
        </div>
      ),
    },
    {
      id: "tokens",
      label: t("tokens"),
      icon: <KeyRound className="size-4" />,
      content: (
        <div className="space-y-6 p-5 sm:p-6 lg:p-8">
          <p className="text-sm text-muted-foreground">
            {workspacesT("accountHint")}
          </p>
          <TokenManager
            tokens={tokens.map((token) => ({
              id: token.id,
              name: token.name,
              prefix: token.prefix,
              createdAt: date(token.createdAt) ?? "",
              lastUsedAt: date(token.lastUsedAt),
            }))}
          />
        </div>
      ),
    },
  ];
  return (
    <ModalSidebarLayout
      label={workspacesT("accountNavigation")}
      sections={sections}
      initialSection={section}
    />
  );
}
