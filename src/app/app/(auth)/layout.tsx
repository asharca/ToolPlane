import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

export const metadata: Metadata = {
  robots: { index: false, follow: false, noarchive: true },
};

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={{ common: messages.common, auth: messages.auth }}>
      <div className="flex min-h-dvh flex-col bg-shell">
        <header className="flex h-14 items-center justify-between px-6">
          <Link href="/" className="group flex items-center gap-2">
            <Logo svgSize={28} wordmarkClass="text-lg" />
          </Link>
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex flex-1 items-center justify-center bg-[radial-gradient(circle_at_50%_12%,hsl(var(--brand)/0.10),transparent_30rem)] px-4 pb-16">
          {children}
        </main>
      </div>
    </NextIntlClientProvider>
  );
}
