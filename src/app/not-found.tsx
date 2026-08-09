import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/layout/Logo';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: `Page not found | ${SITE.name}`,
  robots: { index: false, follow: false, noarchive: true },
};

export default async function NotFound() {
  const [t, common] = await Promise.all([
    getTranslations('errors'),
    getTranslations('common'),
  ]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-lg text-center">
        <Link href="/" aria-label={SITE.name} className="inline-flex">
          <Logo />
        </Link>
        <p className="mt-10 font-mono text-sm font-semibold tracking-[0.2em] text-brand">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{t('notFound')}</h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-7 text-muted-foreground">{t('notFoundDesc')}</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/" className="ui-button-primary min-h-11 px-5">
            <ArrowLeft className="size-4" />
            {t('backHome')}
          </Link>
          <Link href="/search" className="ui-button-secondary min-h-11 px-5">
            <Search className="size-4" />
            {common('search')}
          </Link>
        </div>
      </div>
    </div>
  );
}
