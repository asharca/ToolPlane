import { redirect } from 'next/navigation';

export default async function ChannelsPage({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const returnTo = query.returnTo ? `&returnTo=${encodeURIComponent(query.returnTo)}` : '';
  redirect(`/app/${encodeURIComponent(workspace)}/settings?section=channels${returnTo}`);
}
