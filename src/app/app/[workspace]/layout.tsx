import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getWorkspaceForUser,
  listWorkspacesForUser,
} from '@/lib/workspace/queries';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';
import { UserTimeZoneProvider } from '@/components/timezone/UserTimeZoneProvider';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { runtimeSupportEmail } from '@/lib/site-runtime';
import { readCurrentVersion } from '@/lib/system/release-update';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market`)}`);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const workspaces = await listWorkspacesForUser(user.id);
  const messages = await getMessages();
  const currentVersion = await readCurrentVersion();

  return (
    <NextIntlClientProvider
      messages={{
        common: messages.common,
        console: messages.console,
        auth: messages.auth,
        agentMarket: messages.agentMarket,
      }}
    >
      <UserTimeZoneProvider
        detectedTimeZone={user.detectedTimeZone}
        timeZoneOverride={user.timeZoneOverride}
      >
        <DashboardChrome
          slug={ws.slug}
          workspaceName={ws.name}
          userLabel={user.name ?? user.email}
          workspaces={workspaces}
          supportEmail={runtimeSupportEmail()}
          currentVersion={currentVersion}
          isAdmin={user.role === 'admin'}
        >
          {children}
          {modal}
        </DashboardChrome>
      </UserTimeZoneProvider>
    </NextIntlClientProvider>
  );
}
