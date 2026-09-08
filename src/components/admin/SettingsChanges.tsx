'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

export function settingsAreDirty(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type=hidden]), textarea, select')).some((field) => {
    if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) return field.checked !== field.defaultChecked;
    if (field instanceof HTMLSelectElement) return Array.from(field.options).some((option) => option.selected !== option.defaultSelected);
    return field.value !== field.defaultValue;
  });
}

export function SettingsChanges({ children }: { children: ReactNode }) {
  const t = useTranslations('adminOps');
  const root = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);
  const refresh = () => setDirty(Boolean(root.current && settingsAreDirty(root.current)));

  useEffect(() => {
    const hasChanges = () => Boolean(root.current && settingsAreDirty(root.current));
    const unload = (event: BeforeUnloadEvent) => {
      if (hasChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.pathname === location.pathname && target.search === location.search) return;
      if (hasChanges() && !window.confirm(t('leaveUnsaved'))) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [t]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setDirty(Boolean(root.current && settingsAreDirty(root.current))));
    return () => cancelAnimationFrame(frame);
  }, [children]);

  // Successful saves remount their section by audit id; failed actions must keep the draft.
  return <div ref={root} onInput={refresh} onChange={refresh} onReset={(event) => { event.preventDefault(); requestAnimationFrame(refresh); }} className="space-y-6">
    {dirty ? <p role="status" className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background py-3 text-sm text-amber-700 dark:text-amber-300"><AlertTriangle className="size-4" />{t('unsaved')}</p> : null}
    {children}
  </div>;
}
