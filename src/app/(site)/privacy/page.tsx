import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { ContentPage } from '@/components/theme/ContentPage';
import { mailto } from '@/lib/site';
import { runtimeSupportEmail } from '@/lib/site-runtime';
import { siteMetadata } from '../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return siteMetadata({
    title: t('privacyToolplane'),
    description: t('privacyDescription'),
    path: '/privacy',
  });
}

export default async function Page() {
  const t = await getTranslations('privacy');
  const supportEmail = runtimeSupportEmail();
  return (
    <ContentPage title={t('privacyPolicy')}>
      <p className="font-medium text-foreground">{t('effectiveDate')}</p>
      <p>{t('introduction')}</p>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('operatorTitle')}</h2>
        <p>{t('operatorBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('dataTitle')}</h2>
        <p>{t('dataBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('useTitle')}</h2>
        <p>{t('useBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('cookiesTitle')}</h2>
        <p>{t('cookiesBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('sharingTitle')}</h2>
        <p>{t('sharingBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('retentionTitle')}</h2>
        <p>{t('retentionBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('rightsTitle')}</h2>
        <p>{t('rightsBody')}</p>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-foreground">{t('securityTitle')}</h2>
        <p>{t('securityBody')}</p>
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
