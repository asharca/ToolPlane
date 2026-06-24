import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { uninstallSkillAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function SkillsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const skills = await getInstalledSkills(ws.id);

  return (
    <>
      <DashboardHeader
        title="Skills"
        actions={
          <Link
            href={`/app/${slug}/skills/new`}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Browse Skills
          </Link>
        }
      />
      <div className="px-8 py-6">
        <div className="mb-6 flex items-center justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Agent skills installed in your workspace.
          </p>
          <span className="text-sm text-zinc-400">
            {skills.length} skill{skills.length === 1 ? '' : 's'}
          </span>
        </div>
        {skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 py-20 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No skills installed yet.
            </p>
            <Link
              href={`/app/${slug}/skills/new`}
              className="mt-4 inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Browse Skills
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Skill</th>
                  <th className="px-4 py-3 font-medium">Installed</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {skills.map((s) => (
                  <tr
                    key={s.id}
                    className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {s.skill.iconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.skill.iconUrl}
                            alt=""
                            width={20}
                            height={20}
                            className="size-5 rounded object-cover"
                          />
                        ) : (
                          <span className="size-5 rounded bg-zinc-200 dark:bg-zinc-700" />
                        )}
                        <Link
                          href={`/tools/skills/${s.skill.slug}`}
                          className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                        >
                          {s.skill.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {fmt(s.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-4">
                        <a
                          href={`/api/v1/skills/${s.id}/download`}
                          className="text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                          Download SKILL.md
                        </a>
                        <form action={uninstallSkillAction}>
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="installId" value={s.id} />
                          <button className="text-xs text-zinc-400 transition-colors hover:text-red-600">
                            Uninstall
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
