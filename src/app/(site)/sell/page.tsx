import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('sellSkillsToolplane'),
  };
}

export default async function Page() {
  const t = await getTranslations('sell');
  return (
    <ContentPage title={t('sellYourAgentSkills')}>
      <p>
        {t('listYourAgentSkillsInTheMarketplaceAndReachDevelopersBuildingWithTheModelContextProtocol')}
      </p>
      <p>{t('theSellerWorkflowIsPlannedButNotYetWiredUp')}</p>
    </ContentPage>
  );
}
