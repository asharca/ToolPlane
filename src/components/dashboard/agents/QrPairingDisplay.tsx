'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode } from 'lucide-react';

export function QrPairingDisplay({
  payload,
  label,
  emptyLabel,
}: {
  payload?: string | null;
  label: string;
  emptyLabel: string;
}) {
  const [result, setResult] = useState<{ payload: string; svg: string; error: string | null }>({
    payload: '',
    svg: '',
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const next = payload?.trim() ?? '';
    if (!next) return;
    QRCode.toString(next, {
      type: 'svg',
      margin: 1,
      width: 184,
      color: {
        dark: '#18181b',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (!cancelled) setResult({ payload: next, svg, error: null });
      })
      .catch(() => {
        if (!cancelled) setResult({ payload: next, svg: '', error: 'Could not render this QR code.' });
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const current = payload?.trim() ?? '';
  const svg = current && result.payload === current ? result.svg : '';
  const error = current && result.payload === current ? result.error : null;

  return (
    <div className="flex min-h-56 items-center justify-center rounded-md border border-border bg-white p-3">
      {svg ? (
        <div className="space-y-2 text-center">
          <div className="size-[184px]" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="text-[11px] font-medium text-zinc-600">{label}</div>
        </div>
      ) : (
        <div className="flex size-[184px] flex-col items-center justify-center rounded-sm border border-dashed border-zinc-300 text-center text-xs text-zinc-500">
          <QrCode className="mb-2 size-8 text-zinc-400" />
          {error ?? emptyLabel}
        </div>
      )}
    </div>
  );
}
