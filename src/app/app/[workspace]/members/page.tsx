import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getWorkspaceMembers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const members = await getWorkspaceMembers(ws.id);

  return (
    <>
      <DashboardHeader title="Members" />
      <div className="px-8 py-6">
        <p className="mb-6 text-sm text-zinc-500">
          People with access to this workspace.
        </p>
        <div className="overflow-hidden rounded-lg border border-zinc-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-7 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">
                        {(m.user.name ?? m.user.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <div className="font-medium text-zinc-900">
                          {m.user.name ?? m.user.email.split('@')[0]}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {m.user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5 text-xs capitalize text-zinc-600">
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{fmt(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
