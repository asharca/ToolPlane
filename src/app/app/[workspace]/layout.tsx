import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const requestHeaders = await headers();
  // Fetch metadata stays "iframe" across server redirects that drop the query marker.
  const embedded = requestHeaders.get('sec-fetch-dest') === 'iframe';
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market`)}`);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const workspaces = await listWorkspacesForUser(user.id);
  const messages = await getMessages();

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
          isAdmin={user.role === 'admin'}
          embedded={embedded}
        >
          {children}
        </DashboardChrome>
      </UserTimeZoneProvider>
    </NextIntlClientProvider>
  );
}
