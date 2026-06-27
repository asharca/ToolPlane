import 'server-only';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from './current-user';
import { adminGate, isAdminEmail } from './admin-policy';

// Promote an allowlisted user to admin. Called after a session is established.
export async function reconcileAdminRole(user: { id: string; email: string; role: string }): Promise<void> {
  if (user.role !== 'admin' && isAdminEmail(user.email)) {
    await db.user.update({ where: { id: user.id }, data: { role: 'admin' } });
  }
}

// Gate for /admin layout, admin pages, and admin server actions.
export async function requireAdmin() {
  const user = await getCurrentUser();
  const gate = adminGate(user);
  if (gate === 'login') redirect('/app/login?next=/admin');
  if (gate === 'forbidden') redirect('/');
  return user!;
}
