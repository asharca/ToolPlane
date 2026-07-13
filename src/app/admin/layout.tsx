import { requireAdmin } from '@/lib/auth/admin';
import { AdminChrome } from '@/components/admin/AdminChrome';
import { UserTimeZoneProvider } from '@/components/timezone/UserTimeZoneProvider';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <UserTimeZoneProvider
      detectedTimeZone={admin.detectedTimeZone}
      timeZoneOverride={admin.timeZoneOverride}
    >
      <AdminChrome>{children}</AdminChrome>
    </UserTimeZoneProvider>
  );
}
