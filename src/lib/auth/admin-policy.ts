export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.toLowerCase());
}

export type AdminGate = 'login' | 'forbidden' | 'ok';

export function adminGate(user: { role: string } | null): AdminGate {
  if (!user) return 'login';
  if (user.role !== 'admin') return 'forbidden';
  return 'ok';
}

// Treat suspended accounts as logged-out. Generic so it preserves the input type.
export function activeUserOrNull<T extends { status: string }>(user: T | null): T | null {
  if (!user) return null;
  return user.status === 'suspended' ? null : user;
}
