import { getTranslations } from 'next-intl/server';
import type { PiPackageSummary } from '@/lib/market/pi-package-manifest';

export async function PiPackageDetails({ snapshot, checksum }: { snapshot: PiPackageSummary; checksum: string }) {
  const t = await getTranslations('console.market');
  const source = snapshot.source;
  return (
    <div className="space-y-4">
      <dl className="space-y-3 text-xs">
        {[
          [t('source'), source.kind === 'npm' ? `npm:${source.name}@${source.version}` : source.kind === 'git' ? source.url : t('piCatalog.toolplaneSource')],
          [t('piSourceVersion'), source.kind === 'git' ? source.commit : source.version],
          [t('piPackageName'), `${snapshot.name}${snapshot.version ? ` · ${snapshot.version}` : ''}`],
          [t('piRuntime'), `Pi SDK ${snapshot.runtime.piVersion} · Node ${snapshot.runtime.nodeMajor}`],
          [t('piPlatform'), `${snapshot.runtime.platform}/${snapshot.runtime.arch}`],
          [t('piSnapshotSize'), t('piSnapshotSizeValue', { count: snapshot.fileCount, bytes: snapshot.totalBytes })],
          ['SHA-256', checksum],
          ...(source.kind === 'npm' && source.registry ? [[t('piCatalog.registry'), source.registry]] : []),
        ].map(([label, value]) => (
          <div key={label} className="space-y-1"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono text-foreground">{value}</dd></div>
        ))}
      </dl>
      <div className="space-y-3">
        {([
          ['extensions', 'piExtensions'], ['skills', 'skills'], ['prompts', 'piPrompts'], ['themes', 'piThemes'],
        ] as const).map(([kind, label]) => (
          <div key={kind}>
            <h3 className="text-xs font-semibold">{t(label)} ({snapshot.resources[kind].length})</h3>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">{snapshot.resources[kind].map((path) => <li key={path} className="break-all font-mono">{path}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}
