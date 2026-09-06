import { redirect } from 'next/navigation';

export default async function LegacyAgentChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ agent?: string; c?: string }>;
}) {
  const [{ workspace }, { agent, c }] = await Promise.all([params, searchParams]);
  const query = new URLSearchParams();
  if (agent) query.set('agent', agent);
  if (c) query.set('c', c);
  redirect(`/app/${encodeURIComponent(workspace)}/work${query.size ? `?${query}` : ''}`);
}
