'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}) {
  const t = useTranslations('console.common');
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    let success = false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Clipboard write timed out.')), 500);
        }),
      ]);
      success = true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      success = document.execCommand('copy');
      textarea.remove();
    }
    setStatus(success ? 'copied' : 'failed');
    setTimeout(() => setStatus('idle'), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      {status === 'copied' ? <Check className="size-4" /> : <Copy className="size-4" />}
      {status === 'copied' ? t('copied') : status === 'failed' ? t('copyFailed') : label}
    </button>
  );
}
