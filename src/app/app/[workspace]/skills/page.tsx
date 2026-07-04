import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { uninstallSkillAction } from '@/lib/workspace/actions';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

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
      <DashboardPage>
        <DashboardToolbar
          actions={
            <>
              <Link href={`/app/${slug}/skills/new`} className="ui-button-secondary">
                <Store className="size-4" />
                Browse Skill Market
              </Link>
              <AddSkillDialog slug={slug} />
            </>
          }
        >
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Instructions and assets your agent loads on demand. Author or sync
            from GitHub.
          </p>
        </DashboardToolbar>

        {skills.length === 0 ? (
          <DashboardEmptyState
            title="Create. Refine. Sync."
            description="Skills add focused capabilities to your agent."
            actions={
              <>
                <AddSkillDialog slug={slug} />
                <Link
                  href={`/app/${slug}/skills/new`}
                  className="ui-button-secondary"
                >
                  Browse Skill Market
                </Link>
              </>
            }
          >
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Step {step.n}
                  </p>
                  <p className="mt-1.5 text-sm font-semibold text-foreground">
                    {step.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </DashboardEmptyState>
        ) : null}

        {skills.length > 0 ? (
          <DashboardTable
            headers={[
              { label: 'Skill' },
              { label: 'Added' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {skills.map((s) => {
              const label = skillLabel(s);
              return (
                <tr key={s.id}>
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
                        <span className="size-5 rounded bg-muted" />
                      )}
                      <Link
                        href={`/app/${slug}/skills/${s.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {label.name}
                      </Link>
                      {label.source !== 'catalog' && s.status === 'draft' ? (
                        <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] uppercase text-muted-foreground">
                          Draft
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmt(s.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/app/${slug}/skills/${s.id}`}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Use
                      </Link>
                      <a
                        href={`/api/v1/skills/${s.id}/download`}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Download SKILL.md
                      </a>
                      <form action={uninstallSkillAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="installId" value={s.id} />
                        <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                          Uninstall
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DashboardTable>
        ) : null}
      </DashboardPage>
    </>
  );
}
