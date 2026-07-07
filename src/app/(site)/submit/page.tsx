import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('submitToolplane'),
  };
}

export default async function Page() {
  const t = await getTranslations('submit');
  return (
    <ContentPage title={t('submitAnMcpServer')}>
      <p>
        {t('knowAGreatMcpServerThatShouldBeListedCommunitySubmissionsHelpOthersDiscoverNewToolsAndCapabilities')}
      </p>
      <p>{t('theSubmissionWorkflowIsPlannedButNotYetActive')}</p>
    </ContentPage>
  );
}
