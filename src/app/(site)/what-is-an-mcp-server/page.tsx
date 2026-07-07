import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('whatIsAnMcpServerToolplane'),
  };
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
