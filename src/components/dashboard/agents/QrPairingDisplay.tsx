"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode } from "lucide-react";

export function QrPairingDisplay({
  payload,
  label,
  emptyLabel,
  errorLabel,
}: {
  payload?: string | null;
  label: string;
  emptyLabel: string;
  errorLabel: string;
}) {
  const [result, setResult] = useState<{
    payload: string;
    svg: string;
    error: string | null;
  }>({
    payload: "",
    svg: "",
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const next = payload?.trim() ?? "";
    if (!next) return;
    QRCode.toString(next, {
      type: "svg",
      margin: 1,
      width: 184,
      color: {
        dark: "#18181b",
        light: "#ffffff",
      },
    })
      .then((svg) => {
        if (!cancelled) setResult({ payload: next, svg, error: null });
      })
      .catch(() => {
        if (!cancelled)
          setResult({ payload: next, svg: "", error: errorLabel });
      });
    return () => {
      cancelled = true;
    };
  }, [errorLabel, payload]);

  const current = payload?.trim() ?? "";
  const svg = current && result.payload === current ? result.svg : "";
  const error = current && result.payload === current ? result.error : null;

  return (
    <div className="flex min-h-56 items-center justify-center rounded-md border border-border bg-card p-3">
      {svg ? (
        <div className="space-y-2 text-center">
          <Image
            unoptimized
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            alt={label}
            width={184}
            height={184}
            className="size-[184px]"
          />
          <div className="text-[11px] font-medium text-muted-foreground">
            {label}
          </div>
        </div>
      ) : (
        <div className="flex size-[184px] flex-col items-center justify-center rounded-sm border border-dashed border-border text-center text-xs text-muted-foreground">
          <QrCode className="mb-2 size-8 text-muted-foreground" />
          {error ?? emptyLabel}
        </div>
      )}
    </div>
  );
}
