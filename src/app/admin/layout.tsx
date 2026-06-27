import { requireAdmin } from '@/lib/auth/admin';
import { AdminChrome } from '@/components/admin/AdminChrome';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <AdminChrome>{children}</AdminChrome>;
}
