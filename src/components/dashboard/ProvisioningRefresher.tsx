'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Poll server-owned runtime state until the caller observes readiness.
export function ProvisioningRefresher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
