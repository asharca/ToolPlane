'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';
import { detectClientTimeZone } from '@/lib/timezone';

export type UserTimeZoneContextValue = {
  detectedTimeZone: string | null;
  timeZone: string;
};

export const UserTimeZoneContext = createContext<UserTimeZoneContextValue>({
  detectedTimeZone: null,
  timeZone: 'UTC',
});

function subscribeClientTimeZone(onStoreChange: () => void): () => void {
  const timer = window.setTimeout(onStoreChange, 0);
  return () => window.clearTimeout(timer);
}

export function useDetectedClientTimeZone(): string | null {
  return useSyncExternalStore(
    subscribeClientTimeZone,
    detectClientTimeZone,
    () => null,
  );
}

export function useUserTimeZone(): UserTimeZoneContextValue {
  return useContext(UserTimeZoneContext);
}
