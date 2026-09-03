import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function SettingsProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  redirect(`/app/${encodeURIComponent(workspace)}/providers`);
}
