import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { siteOrigin } from './_lib/metadata';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  metadataBase: siteOrigin(),
};

export default async function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [messages, common] = await Promise.all([
    getMessages(),
    getTranslations('common'),
  ]);
  return (
    <NextIntlClientProvider
      messages={{ common: messages.common }}
    >
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only fixed left-3 top-3 z-[100] rounded-md bg-background px-4 py-2 text-sm font-semibold text-foreground shadow-lg focus:not-sr-only"
        >
          {common('skipToContent')}
        </a>
        <Header />
        <main id="main-content" className="flex-1">{children}</main>
        <Footer />
      </div>
    </NextIntlClientProvider>
  );
}
