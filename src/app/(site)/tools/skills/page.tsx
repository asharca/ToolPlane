import { getLocale } from 'next-intl/server';
import { CapabilityPage } from '@/components/marketing/CapabilityPage';
import { getMarketingContent } from '@/lib/marketing/content';

export default async function Page() {
  const locale = await getLocale();
  return (
    <CapabilityPage
      capability="skills"
      content={getMarketingContent(locale)}
    />
  );
}
