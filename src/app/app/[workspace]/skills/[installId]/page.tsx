import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { SkillEditor } from '@/components/dashboard/SkillEditor';

export const dynamic = 'force-dynamic';

export default async function SkillInspectorPage({
  params,
}: {
  params: Promise<{ workspace: string; installId: string }>;
}) {
  const { workspace: slug, installId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const install = await db.installedSkill.findFirst({
    where: { id: installId, workspaceId: ws.id },
    include: {
      skill: {
        select: { slug: true, name: true, description: true, author: true },
      },
    },
  });
  if (!install) notFound();

  const isCustom = !install.skillId;
  const label = skillLabel(install);
  const markdown = buildInstalledSkillMarkdown(install);

  return (
    <>
      <DashboardHeader
        title={label.name}
        actions={
          <Link
            href={`/app/${slug}/skills`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
        }
      />
      <div className="mx-auto max-w-3xl space-y-8 px-8 py-6">
        {isCustom ? (
          <SkillEditor
            slug={slug}
            installId={install.id}
            status={install.status}
            content={install.content ?? ''}
            description={install.description ?? ''}
            userInvocable={install.userInvocable}
            agentInvocable={install.agentInvocable}
            effort={install.effort}
          />
        ) : (
          <>
            {install.description ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {install.description}
              </p>
            ) : null}

            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                How to use
              </h2>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
                <li>Download or copy the SKILL.md below.</li>
                <li>
                  Drop it into your agent&apos;s skills directory (e.g.{' '}
                  <code className="font-mono">~/.claude/skills/{label.slug}/SKILL.md</code>
                  ).
                </li>
                <li>Your agent loads it automatically when the task matches.</li>
              </ol>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  SKILL.md
                </h2>
                <div className="flex items-center gap-2">
                  <CopyButton text={markdown} label="Copy" />
                  <a
                    href={`/api/v1/skills/${install.id}/download`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    <Download className="size-4" />
                    Download
                  </a>
                </div>
              </div>
              <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                {markdown}
              </pre>
            </section>
          </>
        )}
      </div>
    </>
  );
}
