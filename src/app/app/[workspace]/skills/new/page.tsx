import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { installSkillAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function BrowseSkillsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [skills, installed] = await Promise.all([
    db.skill.findMany({
      orderBy: { score: 'desc' },
      take: 24,
      select: { id: true, name: true, description: true, iconUrl: true },
    }),
    getInstalledSkills(ws.id),
  ]);
  const installedIds = new Set(installed.map((i) => i.skillId));

  return (
    <>
      <DashboardHeader
        title="Browse Skills"
        actions={
          <Link
            href={`/app/${slug}/skills`}
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
          >
            ← Back to skills
          </Link>
        }
      />
      <div className="px-8 py-6">
        <BrowseGrid
          items={skills}
          installedIds={installedIds}
          slug={slug}
          action={installSkillAction}
          idField="skillId"
          actionLabel="Install"
          installedLabel="Installed"
        />
      </div>
    </>
  );
}
