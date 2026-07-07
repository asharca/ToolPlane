import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  listToolkits,
  getOrCreateDefaultToolkit,
} from '@/lib/toolkits/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ToolkitsBrowser } from '@/components/dashboard/ToolkitsBrowser';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function ToolkitsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const t = await getTranslations('console.toolkits');
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  await getOrCreateDefaultToolkit(ws.id);
  const toolkits = await listToolkits(ws.id);

  return (
    <>
      <DashboardHeader title={t('toolkits')} />
      <ToolkitsBrowser
        slug={slug}
        toolkits={toolkits.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          visibility: t.visibility,
          enabled: t.enabled,
          toolCount: t.toolCount,
          created: fmt(t.createdAt),
        }))}
      />
    </>
  );
}
