import { isDeepStrictEqual } from 'node:util';
import { getTranslations } from 'next-intl/server';
import { AdminPanel } from './AdminUI';

export async function ReleaseChanges({ before, after }: { before: unknown; after: unknown }) {
  const t = await getTranslations('adminOps');
  const previous = before && typeof before === 'object' ? before as Record<string, unknown> : {};
  const next = after && typeof after === 'object' ? after as Record<string, unknown> : {};
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter((key) => !isDeepStrictEqual(previous[key], next[key]));
  return <AdminPanel title={t('versionChanges')}>
    {!before ? <p className="mb-3 text-sm text-muted-foreground">{t('firstRelease')}</p> : null}
    {keys.length ? keys.map((key) => <details key={key} className="border-b border-border py-3">
      <summary className="cursor-pointer break-all font-mono text-sm">{key}</summary>
      <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-2">{[{ label: t('currentVersion'), value: previous[key] }, { label: t('submittedVersion'), value: next[key] }].map(({ label, value }) => <div key={label} className="min-w-0">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">{label}</h3>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs leading-6">{JSON.stringify(value, null, 2) ?? '-'}</pre>
      </div>)}</div>
    </details>) : <p className="text-sm text-muted-foreground">{t('unchanged')}</p>}
  </AdminPanel>;
}
