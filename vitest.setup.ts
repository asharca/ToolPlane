import 'dotenv/config';
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import messages from './messages/en.json';

function lookupMessage(path: string) {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment];
  }, messages);
}

function formatMessage(template: string, values?: Record<string, unknown>) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
      const path = namespace ? `${namespace}.${key}` : key;
      const resolved = lookupMessage(path);
      if (typeof resolved === 'string') {
        return formatMessage(resolved, values);
      }
      return key;
    },
  };
});
