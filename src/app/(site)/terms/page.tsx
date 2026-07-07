import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('termsToolplane'),
  };
}

export default async function Page() {
  const t = await getTranslations('terms');
  return (
    <ContentPage title={t('termsOfUse')}>
      <p>
        {t('toolplaneIsProvidedAsisWithNoWarrantiesOfAnyKindUseItOnlyInEnvironmentsWhereYouControlTheDeployedMcpServersConnectorsAndSandboxRuntimes')}
      </p>
      <p>
        {t('trademarksPackageNamesAndThirdpartyContentReferencedHereBelongToTheirRespectiveOwners')}
      </p>
    </ContentPage>
  );
}
