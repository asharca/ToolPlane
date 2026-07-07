import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('newsToolplane'),
  };
}

export default async function Page() {
  const t = await getTranslations('news');
  return (
    <ContentPage title={t('news')}>
      <p>{t('theLatestUpdatesFromTheMcpEcosystem')}</p>
      <p>{t('noArticlesYet')}</p>
    </ContentPage>
  );
}
