import { redirect } from 'next/navigation';
import {
  legacyMarketRedirectTarget,
  type MarketSearchParams,
} from '@/lib/workspace/market-url';

export default async function LegacySkillMarketRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<MarketSearchParams>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  redirect(legacyMarketRedirectTarget(workspace, 'skills', query));
}
