import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { PersonalSettingsContent } from '@/components/dashboard/PersonalSettingsContent';
import { SettingsModal } from '@/components/dashboard/SettingsModal';

export const dynamic = 'force-dynamic';

export default async function PersonalSettingsPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ returnTo?: string; section?: string }> }) {
  const { workspace: slug } = await params;
  const query = await searchParams;
  const [user, t] = await Promise.all([
    getCurrentUser(),
    getTranslations('console.workspaces'),
  ]);
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app?view=workspaces&notice=unavailable');

  const section = query.section === 'security' || query.section === 'tokens' ? query.section : 'preferences';
  return (
    <SettingsModal title={t('account')} fallbackHref={`/app/${slug}/chat`}>
      <PersonalSettingsContent user={user} workspaceSlug={slug} section={section} returnTo={query.returnTo} />
    </SettingsModal>
  );
}
