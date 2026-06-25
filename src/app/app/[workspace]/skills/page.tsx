import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { uninstallSkillAction } from '@/lib/workspace/actions';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const STEPS = [
  {
    n: '01',
    title: 'Create or import',
    body: 'Write a skill from scratch, or pull one from a GitHub repo.',
  },
  {
    n: '02',
    title: 'Refine in place',
    body: "Iterate and refine. Every save is versioned, so it's safe to experiment.",
  },
  {
    n: '03',
    title: 'Sync everywhere',
    body: 'Skills stay in sync across every client and toolkit. Update once, ship everywhere.',
  },
];


export default async function SkillsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const skills = await getInstalledSkills(ws.id);

  return (
    <>
      <DashboardHeader title="Skills" />
      <div className="px-8 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Instructions and assets your agent loads on demand. Author or sync
            from GitHub.
          </p>
          <AddSkillDialog slug={slug} />
        </div>

        {skills.length === 0 ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-8 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Create. Refine. Sync.
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Skills add focused capabilities to your agent.
            </p>
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Step {step.n}
                  </p>
                  <p className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {step.title}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <AddSkillDialog slug={slug} />
              <Link
                href="/tools/skills"
                className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Browse directory
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Skill</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {skills.map((s) => {
                  const label = skillLabel(s);
                  return (
                    <tr
                      key={s.id}
                      className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {s.skill?.iconUrl ? (
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
                            href={`/app/${slug}/skills/${s.id}`}
                            className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                          >
                            {label.name}
                          </Link>
                          {label.source !== 'catalog' && s.status === 'draft' ? <span className="ml-2 rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] uppercase text-zinc-500 dark:border-zinc-700">Draft</span> : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                        {fmt(s.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-4">
                          <Link
                            href={`/app/${slug}/skills/${s.id}`}
                            className="text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                          >
                            Use
                          </Link>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
