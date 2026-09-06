'use client';

import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

const values = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function readValue(storageKey: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'true' || stored === 'false') {
      const value = stored === 'true';
      return value;
    }
    return fallback;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return values.get(storageKey) ?? fallback;
}

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

export function usePersistentBoolean(storageKey: string, fallback: boolean) {
  const subscribeToValue = useCallback((listener: () => void) => subscribe(storageKey, listener), [storageKey]);
  const getSnapshot = useCallback(() => readValue(storageKey, fallback), [fallback, storageKey]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribeToValue, getSnapshot, getServerSnapshot);

  const setPersistentValue = useCallback((nextValue: SetStateAction<boolean>) => {
    const current = readValue(storageKey, fallback);
    const next = typeof nextValue === 'function' ? nextValue(current) : nextValue;
    try {
      window.localStorage.setItem(storageKey, String(next));
      values.delete(storageKey);
    } catch {
      // Keep the current page interactive when persistence is unavailable.
      values.set(storageKey, next);
    }
    notify(storageKey);
  }, [fallback, storageKey]);

  return [value, setPersistentValue] as const;
}
