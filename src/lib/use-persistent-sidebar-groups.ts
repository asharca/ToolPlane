'use client';

import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type SetStateAction,
} from 'react';
import {
  parseSidebarGroupPreferences,
  serializeSidebarGroupPreferences,
  serializeSidebarGroupPreferencesCookie,
  type SidebarGroupPreferences,
} from '@/lib/sidebar-groups';

const values = new Map<string, SidebarGroupPreferences>();
const snapshots = new Map<string, {
  raw: string | null;
  fallback?: SidebarGroupPreferences;
  usesFallback: boolean;
  value: SidebarGroupPreferences;
}>();
const listeners = new Map<string, Set<() => void>>();

function notify(storageKey: string) {
  listeners.get(storageKey)?.forEach((listener) => listener());
}

function subscribe(storageKey: string, listener: () => void) {
  const keyListeners = listeners.get(storageKey) ?? new Set<() => void>();
  keyListeners.add(listener);
  listeners.set(storageKey, keyListeners);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey && event.storageArea === window.localStorage) listener();
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    keyListeners.delete(listener);
    if (!keyListeners.size) listeners.delete(storageKey);
    window.removeEventListener('storage', handleStorage);
  };
}

function readPreferences(storageKey: string, fallback: SidebarGroupPreferences) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = parseSidebarGroupPreferences(raw);
    const cached = snapshots.get(storageKey);
    if (cached?.raw === raw && (!cached.usesFallback || cached.fallback === fallback)) return cached.value;
    const value = parsed ?? fallback;
    snapshots.set(storageKey, {
      raw,
      value,
      usesFallback: !parsed,
      ...(parsed ? {} : { fallback }),
    });
    return value;
  } catch {
    return values.get(storageKey) ?? fallback;
  }
}

function persistCookie(cookieName: string, value: SidebarGroupPreferences) {
  document.cookie = `${cookieName}=${serializeSidebarGroupPreferencesCookie(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function usePersistentSidebarGroups(
  storageKey: string,
  fallback: SidebarGroupPreferences,
  cookieName: string,
) {
  const subscribeToValue = useCallback((listener: () => void) => subscribe(storageKey, listener), [storageKey]);
  const getSnapshot = useCallback(() => readPreferences(storageKey, fallback), [fallback, storageKey]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribeToValue, getSnapshot, getServerSnapshot);

  useEffect(() => {
    persistCookie(cookieName, value);
  }, [cookieName, value]);

  const setPersistentValue = useCallback((nextValue: SetStateAction<SidebarGroupPreferences>) => {
    const current = readPreferences(storageKey, fallback);
    const next = typeof nextValue === 'function' ? nextValue(current) : nextValue;
    try {
      const raw = serializeSidebarGroupPreferences(next);
      window.localStorage.setItem(storageKey, raw);
      snapshots.set(storageKey, { raw, value: next, usesFallback: false });
      values.delete(storageKey);
    } catch {
      // Keep the current page interactive when persistence is unavailable.
      values.set(storageKey, next);
    }
    persistCookie(cookieName, next);
    notify(storageKey);
  }, [cookieName, fallback, storageKey]);

  return [value, setPersistentValue] as const;
}
