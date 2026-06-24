import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listCategories } from '@/lib/queries/categories';
import { db } from '@/lib/db';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { submitSkillAction } from '@/lib/seller/actions';

export const dynamic = 'force-dynamic';

const field =
  'h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export default async function SellerPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [categories, submissions] = await Promise.all([
    listCategories(),
    db.skill.findMany({
      where: { author: user.email },
      orderBy: { createdAt: 'desc' },
      include: { categories: { select: { name: true }, take: 1 } },
    }),
  ]);

  return (
    <>
      <DashboardHeader title="Sell Skills" />
      <div className="mx-auto max-w-3xl space-y-10 px-8 py-6">
        <section>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Publish an agent skill
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            List a skill in the MCP Market directory. It goes live immediately
            under your account.
          </p>

          <form action={submitSkillAction} className="mt-5 space-y-4">
            <input type="hidden" name="workspace" value={slug} />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Skill name
              </label>
              <input name="name" required maxLength={80} className={field} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Description
              </label>
              <textarea
                name="description"
                rows={3}
                maxLength={400}
                className={`${field} h-auto py-2`}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Category
              </label>
              <select name="categoryId" className={field} defaultValue="">
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Publish skill
            </button>
          </form>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Your listings ({submissions.length})
          </h2>
          {submissions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              You haven&apos;t published any skills yet.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {submissions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/tools/skills/${s.slug}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {s.name}
                    </Link>
                    {s.categories[0] ? (
                      <span className="ml-2 text-xs uppercase tracking-wide text-zinc-400">
                        {s.categories[0].name}
                      </span>
                    ) : null}
                    {s.description ? (
                      <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                        {s.description}
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={`/tools/skills/${s.slug}`}
                    className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    View
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
