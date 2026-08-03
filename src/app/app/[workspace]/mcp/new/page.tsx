import { redirect } from 'next/navigation';
import {
  legacyMarketRedirectTarget,
  type MarketSearchParams,
} from '@/lib/workspace/market-url';

export default async function LegacyMcpMarketRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<MarketSearchParams>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  redirect(legacyMarketRedirectTarget(workspace, 'mcp', query));
}
