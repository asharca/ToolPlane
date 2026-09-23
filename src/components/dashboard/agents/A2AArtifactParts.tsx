'use client';
import { Button } from '@asharca/ui';
import { useTranslations } from 'next-intl';

export type A2AWirePart = { text?: string; data?: Record<string, unknown>; raw?: string; mediaType?: string };
/** Files are explicit downloads, never active previews or arbitrary remote URLs. */
export function A2AArtifactParts({ name, parts }: { name: string; parts: A2AWirePart[] }) {
  const t = useTranslations('console.agents.a2a');
  return <>{parts.map((part, index) => {
    if (typeof part.text === 'string') return <pre key={index} className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{part.text}</pre>;
    if (part.data && typeof part.data === 'object') return <pre key={index} className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(part.data, null, 2)}</pre>;
    if (typeof part.raw !== 'string' || part.raw.length > 43_692) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const raw = atob(part.raw); if (raw.length > 32_768) return null;
      bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
    } catch { return null; }
    return <div key={index} className="space-y-2"><p className="text-xs text-muted-foreground">{t('artifactDownloadWarning', { bytes: bytes.length })}</p>
      <Button size="sm" variant="secondary" onClick={() => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 100) || 'artifact.bin';
        anchor.rel = 'noopener'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>{t('downloadArtifact')}</Button></div>;
  })}</>;
}
