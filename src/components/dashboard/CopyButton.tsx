'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { StatefulButton, type ButtonState } from '@/components/motion/button/stateful';

async function copyText(text: string): Promise<boolean> {
  let timer: number | undefined;
  try {
    if (navigator.clipboard?.writeText) {
      await Promise.race([navigator.clipboard.writeText(text), new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Clipboard timeout')), 2000); })]);
      return true;
    }
  } catch { /* Non-secure contexts and denied permissions use the native fallback. */ }
  finally { window.clearTimeout(timer); }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  try {
    (active?.closest('[role="dialog"]') ?? document.body).append(field);
    field.focus(); field.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch { return false; }
  finally {
    field.remove(); active?.focus({ preventScroll: true });
    if (inputSelection?.start != null && inputSelection.end != null && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    else if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)); }
  }
}

export function CopyButton({ text, label = 'Copy', className, iconOnly = false }: { text: string; label?: string; className?: string; iconOnly?: boolean }) {
  const t = useTranslations('console.common');
  const [state, setState] = useState<ButtonState>('idle');
  const busy = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  const statusLabel = state === 'success' ? t('copied') : state === 'error' ? t('copyFailed') : label;
  async function copy() {
    if (busy.current) return;
    busy.current = true;
    clearTimeout(timer.current);
    setState('loading');
    const copied = await copyText(text);
    busy.current = false;
    if (!mounted.current) return;
    setState(copied ? 'success' : 'error');
    timer.current = window.setTimeout(() => setState('idle'), 1500);
  }
  return <StatefulButton variant="secondary" size={iconOnly ? 'icon' : 'sm'} className={className} state={state} onClick={copy} icon={<Copy className="size-4" />} aria-label={iconOnly ? statusLabel : undefined} title={iconOnly ? statusLabel : undefined}
    loadingText={iconOnly ? <span className="sr-only">{label}</span> : label} successText={iconOnly ? <span className="sr-only">{t('copied')}</span> : t('copied')} errorText={iconOnly ? <span className="sr-only">{t('copyFailed')}</span> : t('copyFailed')}>
    <span className={iconOnly ? 'sr-only' : undefined} role="status" aria-live="polite">{label}</span>
  </StatefulButton>;
}
