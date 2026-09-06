'use client';

import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type SetStateAction,
} from 'react';
import { serializeBooleanRecordCookie } from '@/lib/sidebar-preferences';

const values = new Map<string, boolean>();
const recordValues = new Map<string, Record<string, boolean>>();
const recordSnapshots = new Map<string, {
  raw: string | null;
  fallback?: Record<string, boolean>;
  usesFallback: boolean;
  value: Record<string, boolean>;
}>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY_BOOLEAN_RECORD: Record<string, boolean> = {};

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

function persistCookie(cookieName: string, value: boolean) {
  document.cookie = `${cookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function persistRecordCookie(cookieName: string, value: Record<string, boolean>) {
  document.cookie = `${cookieName}=${serializeBooleanRecordCookie(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
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

export function usePersistentBoolean(storageKey: string, fallback: boolean, cookieName?: string) {
  const subscribeToValue = useCallback((listener: () => void) => subscribe(storageKey, listener), [storageKey]);
  const getSnapshot = useCallback(() => readValue(storageKey, fallback), [fallback, storageKey]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribeToValue, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (cookieName) persistCookie(cookieName, value);
  }, [cookieName, value]);

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
    if (cookieName) persistCookie(cookieName, next);
    notify(storageKey);
  }, [cookieName, fallback, storageKey]);

  return [value, setPersistentValue] as const;
}

function parseBooleanRecord(raw: string | null): Record<string, boolean> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

function readBooleanRecord(storageKey: string, fallback: Record<string, boolean>) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = parseBooleanRecord(raw);
    const cached = recordSnapshots.get(storageKey);
    if (cached?.raw === raw && (!cached.usesFallback || cached.fallback === fallback)) return cached.value;
    const value = parsed ?? fallback;
    recordSnapshots.set(storageKey, {
      raw,
      value,
      usesFallback: !parsed,
      ...(parsed ? {} : { fallback }),
    });
    return value;
  } catch {
    return recordValues.get(storageKey) ?? fallback;
  }
}

export function usePersistentBooleanRecord(
  storageKey: string,
  fallback: Record<string, boolean> = EMPTY_BOOLEAN_RECORD,
  cookieName?: string,
) {
  const subscribeToValue = useCallback((listener: () => void) => subscribe(storageKey, listener), [storageKey]);
  const getSnapshot = useCallback(() => readBooleanRecord(storageKey, fallback), [fallback, storageKey]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribeToValue, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (cookieName) persistRecordCookie(cookieName, value);
  }, [cookieName, value]);

  const setPersistentValue = useCallback((nextValue: SetStateAction<Record<string, boolean>>) => {
    const current = readBooleanRecord(storageKey, fallback);
    const next = typeof nextValue === 'function' ? nextValue(current) : nextValue;
    try {
      const raw = JSON.stringify(next);
      window.localStorage.setItem(storageKey, raw);
      recordSnapshots.set(storageKey, { raw, value: next, usesFallback: false });
      recordValues.delete(storageKey);
    } catch {
      // Keep the current page interactive when persistence is unavailable.
      recordValues.set(storageKey, next);
    }
    if (cookieName) persistRecordCookie(cookieName, next);
    notify(storageKey);
  }, [cookieName, fallback, storageKey]);

  return [value, setPersistentValue] as const;
}
