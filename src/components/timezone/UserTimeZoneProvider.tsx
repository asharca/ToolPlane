'use client';

import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { syncDetectedTimeZone } from '@/lib/auth/timezone-actions';
import {
  normalizeTimeZone,
  resolveTimeZone,
} from '@/lib/timezone';
import {
  UserTimeZoneContext,
  useDetectedClientTimeZone,
  type UserTimeZoneContextValue,
} from './UserTimeZoneContext';

export function UserTimeZoneProvider({
  children,
  detectedTimeZone,
  timeZoneOverride,
}: {
  children: ReactNode;
  detectedTimeZone: string | null;
  timeZoneOverride: string | null;
}) {
  const router = useRouter();
  const clientTimeZone = useDetectedClientTimeZone();
  const syncingTimeZone = useRef<string | null>(null);
  const savedDetectedTimeZone = normalizeTimeZone(detectedTimeZone);

  useEffect(() => {
    const detected = clientTimeZone;
    if (!detected || detected === savedDetectedTimeZone) return;
    if (syncingTimeZone.current === detected) return;

    syncingTimeZone.current = detected;
    void syncDetectedTimeZone(detected)
      .then((updated) => {
        if (updated) startTransition(() => router.refresh());
      })
      .catch(() => {
        syncingTimeZone.current = null;
      });
  }, [clientTimeZone, router, savedDetectedTimeZone]);

  const effectiveDetectedTimeZone = clientTimeZone ?? savedDetectedTimeZone;
  const value = useMemo<UserTimeZoneContextValue>(() => ({
    detectedTimeZone: effectiveDetectedTimeZone,
    timeZone: resolveTimeZone(timeZoneOverride ?? effectiveDetectedTimeZone),
  }), [effectiveDetectedTimeZone, timeZoneOverride]);

  return (
    <UserTimeZoneContext.Provider value={value}>
      {children}
    </UserTimeZoneContext.Provider>
  );
}
