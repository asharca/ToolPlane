import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';
import { mailto } from '@/lib/site';
import { runtimeSupportEmail } from '@/lib/site-runtime';
import { siteMetadata } from '../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return siteMetadata({
    title: t('termsToolplane'),
    description: t('termsDescription'),
    path: '/terms',
  });
}

export default async function Page() {
  const t = await getTranslations('terms');
  const supportEmail = runtimeSupportEmail();
  return (
    <ContentPage title={t('termsOfUse')}>
      <p className="font-medium text-foreground">{t('effectiveDate')}</p>
      <p>{t('introduction')}</p>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('operatorTitle')}</h2>
        <p>{t('operatorBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('accountsTitle')}</h2>
        <p>{t('accountsBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('acceptableUseTitle')}</h2>
        <p>{t('acceptableUseBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('contentTitle')}</h2>
        <p>{t('contentBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('thirdPartyTitle')}</h2>
        <p>{t('thirdPartyBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('availabilityTitle')}</h2>
        <p>{t('availabilityBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('terminationTitle')}</h2>
        <p>{t('terminationBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('liabilityTitle')}</h2>
        <p>{t('liabilityBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('lawTitle')}</h2>
        <p>{t('lawBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('changesTitle')}</h2>
        <p>{t('changesBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('contactTitle')}</h2>
        <p>
          {t('contactBody')}{' '}
          <a className="font-medium text-foreground underline underline-offset-4" href={mailto(supportEmail)}>
            {supportEmail}
          </a>
          .
        </p>
      </section>
    </ContentPage>
  );
}
