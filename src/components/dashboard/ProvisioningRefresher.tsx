'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// While any deployment is provisioning (e.g. npx is still downloading a custom
// server), poll the server component so its status flips to running on its own.
export function ProvisioningRefresher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
