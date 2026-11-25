import { getLocale, getTranslations } from "next-intl/server";
import { listApiTokens } from "@/lib/auth/tokens";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { TimeZoneSettings } from "@/components/timezone/TimeZoneSettings";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ChangePasswordForm } from "@/components/auth/PasswordRecoveryForms";
import { DialogBody } from "./dialog";
import { ModalSidebarLayout } from "./ModalSidebarLayout";
import { TokenManager } from "./TokenManager";
import type { WorkspaceAccountUser } from "./WorkspaceAccountPage";

export type PersonalSettingsSection = "preferences" | "security" | "tokens";

export async function PersonalSettingsContent({
  user,
  section = "preferences",
  workspaceSlug = "",
}: {
  user: WorkspaceAccountUser;
  section?: PersonalSettingsSection;
  workspaceSlug?: string;
}) {
  const [t, workspacesT, authT, locale, tokens] = await Promise.all([
    getTranslations("console.settings"),
    getTranslations("console.workspaces"),
    getTranslations("auth"),
    getLocale(),
    listApiTokens(user.id),
  ]);
  const timeZone = resolveUserTimeZone(user);
  const date = (value: Date | null) =>
    value
      ? formatInTimeZone(value, timeZone, { dateStyle: "medium" }, locale)
      : null;

  const sections = [
    {
      id: "preferences",
      label: t("preferences"),
      content: (
        <DialogBody>
          <div className="space-y-5 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">{authT("email")}</span>
              <p className="break-all text-sm">{user.email}</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">{t("language")}</span>
              <LocaleSwitcher />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {workspacesT("appearance")}
              </span>
              <ThemeToggle showLabel />
            </div>
            <div className="border-t border-border pt-5">
              <TimeZoneSettings timeZoneOverride={user.timeZoneOverride} />
            </div>
          </div>
        </DialogBody>
      ),
    },
    {
      id: "security",
      label: t("security"),
      content: (
        <DialogBody>
          <div className="space-y-5 rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              {t("passwordSettingsDesc")}
            </p>
            <ChangePasswordForm email={user.email} />
          </div>
        </DialogBody>
      ),
    },
    {
      id: "tokens",
      label: t("tokens"),
      content: (
        <DialogBody>
          <TokenManager
            workspaceSlug={workspaceSlug}
            tokens={tokens.map((token) => ({
              id: token.id,
              name: token.name,
              prefix: token.prefix,
              createdAt: date(token.createdAt) ?? "",
              lastUsedAt: date(token.lastUsedAt),
            }))}
          />
        </DialogBody>
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
