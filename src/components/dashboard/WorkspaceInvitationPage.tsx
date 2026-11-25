import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { Logo } from "@/components/layout/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { DashboardPanel } from "./DashboardUI";
import { WorkspaceInvitation } from "./WorkspaceInvitation";

export async function WorkspaceInvitationPage({
  signedIn,
}: {
  signedIn: boolean;
}) {
  const [messages, t] = await Promise.all([
    getMessages(),
    getTranslations("console.workspaces"),
  ]);
  return (
    <NextIntlClientProvider
      messages={{
        common: messages.common,
        console: messages.console,
        auth: messages.auth,
      }}
    >
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <header className="flex h-14 items-center justify-between px-6">
          <Link href="/" className="group flex items-center gap-2">
            <Logo svgSize={28} wordmarkClass="text-lg" />
          </Link>
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-xl flex-1 px-4 py-12">
          <DashboardPanel
            title={t("invitationTitle")}
            description={t("sharedHint")}
          >
            <WorkspaceInvitation signedIn={signedIn} />
          </DashboardPanel>
        </main>
      </div>
    </NextIntlClientProvider>
  );
}
