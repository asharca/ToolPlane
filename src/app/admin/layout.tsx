import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { AdminChrome } from '@/components/admin/AdminChrome';
import { UserTimeZoneProvider } from '@/components/timezone/UserTimeZoneProvider';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin');
  return {
    title: `${t('adminConsoleTitle')} | ToolPlane`,
    robots: { index: false, follow: false },
  };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={{ common: messages.common, admin: messages.admin }}>
      <UserTimeZoneProvider
        detectedTimeZone={admin.detectedTimeZone}
        timeZoneOverride={admin.timeZoneOverride}
      >
        <AdminChrome>{children}</AdminChrome>
      </UserTimeZoneProvider>
    </NextIntlClientProvider>
  );
}
