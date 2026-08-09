import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';
import { siteMetadata } from '../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return siteMetadata({
    title: t('whatIsAnMcpServerToolplane'),
    description: t('siteDescription'),
    path: '/what-is-an-mcp-server',
  });
}

export default async function Page() {
  const t = await getTranslations('aboutMcp');
  return (
    <ContentPage title={t('whatIsMcp')}>
      <p>
        {t('anMcpModelContextProtocolServerIsASmallProgramThatExposesToolsDataAndPromptsToAiApplicationsThroughASingleStandardInterfaceInsteadOfBuildingACustomIntegrationForEveryServiceAnAiAppCanConnectToAnyMcpServerAndImmediatelyUseWhatItOffers')}
      </p>
      <p>
        {t('aClientInsideTheAiAppConnectsToTheServerOverATransportSuchAsStdioOrStreamableHttpTheServerAdvertisesItsCapabilitiesForExampleQueryingADatabaseCallingAnApiOrReadingFilesAndTheModelCanDiscoverAndInvokeThemAtRuntime')}
      </p>
      <p>
        {t('becauseTheProtocolIsStandardizedTheSameServerWorksAcrossAnyMcpcompatibleClientAndDevelopersCanExtendWhatTheirAiCanDoSimplyByAddingMoreServers')}
      </p>
    </ContentPage>
  );
}
