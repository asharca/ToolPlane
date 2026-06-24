import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getOrCreateDefaultWorkspace } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

export default async function AppIndexPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/app');
  const ws = await getOrCreateDefaultWorkspace(user.id, user.email);
  redirect(`/app/${ws.slug}/mcp`);
}
