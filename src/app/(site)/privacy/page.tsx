import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('privacyToolplane'),
  };
}

export default async function Page() {
  const t = await getTranslations('privacy');
  return (
    <ContentPage title={t('privacyPolicy')}>
      <p>
        {t('toolplaneStoresTheAccountWorkspaceRuntimeAndObservabilityDataNeededToOperateAgentToolchainsItDoesNotUseAdvertisingCookiesOrThirdpartyTracking')}
      </p>
    </ContentPage>
  );
}
