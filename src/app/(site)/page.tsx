import { getLocale } from 'next-intl/server';
import { MarketingHome } from '@/components/marketing/MarketingHome';
import { getMarketingContent } from '@/lib/marketing/content';

export default async function Home() {
  const locale = await getLocale();
  return <MarketingHome content={getMarketingContent(locale)} />;
}
