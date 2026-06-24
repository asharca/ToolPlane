import { notFound } from 'next/navigation';
import { ServerList } from '@/components/server/ServerList';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) notFound();
  return <ServerList page={n} />;
}
