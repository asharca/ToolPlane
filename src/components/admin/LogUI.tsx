import { useTranslations } from 'next-intl';
import { AdminBadge, type AdminBadgeTone } from './AdminUI';

const outcomeTones: Record<string, AdminBadgeTone> = {
  success: 'success', error: 'danger', timeout: 'warning', denied: 'warning', cancelled: 'neutral',
};

export function LogOutcomeBadge({ outcome }: { outcome: string }) {
  const t = useTranslations('admin');
  return <AdminBadge tone={outcomeTones[outcome] ?? 'neutral'} dot>
    {t.has(`logOutcomes.${outcome}`) ? t(`logOutcomes.${outcome}`) : outcome}
  </AdminBadge>;
}

export function LogTimestamp({ date, compact = false }: { date: Date; compact?: boolean }) {
  const iso = date.toISOString();
  return <time dateTime={iso} title={iso} className="block whitespace-nowrap font-mono text-xs tabular-nums">
    <span className="block text-foreground">{iso.slice(11, 23)}</span>
    {!compact ? <span className="mt-1 block text-muted-foreground">{iso.slice(0, 10)}</span> : null}
  </time>;
}
