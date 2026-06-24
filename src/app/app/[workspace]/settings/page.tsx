import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import {
  renameWorkspaceAction,
  deleteWorkspaceAction,
} from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const isOwner = ws.ownerId === user.id;

  return (
    <>
      <DashboardHeader title="Settings" />
      <div className="max-w-2xl space-y-8 px-8 py-6">
        <section className="rounded-lg border border-zinc-200">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-zinc-900">
              Workspace name
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Shown across the dashboard.
            </p>
          </div>
          <form
            action={renameWorkspaceAction}
            className="flex items-center gap-3 px-5 py-4"
          >
            <input type="hidden" name="workspace" value={slug} />
            <input
              name="name"
              defaultValue={ws.name}
              className="h-9 flex-1 rounded-md border border-zinc-200 px-3 text-sm text-zinc-900"
            />
            <button className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800">
              Save
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-zinc-200">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-zinc-900">Workspace URL</h2>
          </div>
          <div className="px-5 py-4 text-sm text-zinc-600">
            /app/<span className="font-medium text-zinc-900">{ws.slug}</span>
          </div>
        </section>

        {isOwner ? (
          <section className="rounded-lg border border-red-200">
            <div className="border-b border-red-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
              <p className="mt-0.5 text-xs text-red-500">
                Deleting a workspace is permanent.
              </p>
            </div>
            <form action={deleteWorkspaceAction} className="px-5 py-4">
              <input type="hidden" name="workspace" value={slug} />
              <button className="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50">
                Delete workspace
              </button>
            </form>
          </section>
        ) : null}
      </div>
    </>
  );
}
