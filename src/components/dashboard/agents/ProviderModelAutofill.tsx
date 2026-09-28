'use client';

import { useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { lookupProviderModelReferencesAction } from '@/lib/agents/model-reference-actions';
import { fillProviderModelMetadata, type ProviderModelValues } from '@/lib/agents/model-catalog';

export function ProviderModelAutofill({ slug, providerId, modelId, name, open, setModel, manualFields }: {
  slug: string;
  providerId: string;
  modelId: string;
  name: string;
  open: boolean;
  setModel: Dispatch<SetStateAction<ProviderModelValues>>;
  manualFields: RefObject<Set<keyof ProviderModelValues>>;
}) {
  const t = useTranslations('console.agents');
  const queries = useMemo(() => {
    const ids = modelId.replaceAll('，', ',').split(',').map((id) => id.trim()).filter(Boolean);
    if (ids.length !== 1) return [];
    return [...new Set([...ids, name.trim()].filter((query) => query && query.length <= 200))];
  }, [modelId, name]);
  const key = JSON.stringify([slug, providerId, queries]);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !queries.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupProviderModelReferencesAction(slug, providerId, queries)
        .then((result) => {
          if (cancelled) return;
          if (result.error) { setFailedKey(key); return; }
          setFailedKey(null);
          const reference = result.matches[0];
          if (!reference) return;
          setModel((current) => {
            if (cancelled || current.modelId !== modelId || current.name !== name) return current;
            const filled = fillProviderModelMetadata(current, reference);
            const manual = Object.fromEntries([...manualFields.current].map((field) => [field, current[field]]));
            return { ...filled, ...manual };
          });
        })
        .catch(() => { if (!cancelled) setFailedKey(key); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, slug, providerId, modelId, name, queries, key, setModel, manualFields]);

  return open && queries.length > 0 && failedKey === key
    ? <p role="alert" className="mt-3 text-xs text-destructive">{t('catalogLookupFailed')}</p>
    : null;
}
