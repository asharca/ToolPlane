'use client';
import { Button } from '@/components/motion/button';


import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { RefreshCw, Link2, ExternalLink } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { ToolkitInstallations } from './ToolkitInstallations';
import { buildDirectSnippet, DIRECT_CLIENTS, directClientLabel, type DirectClient } from '@/lib/plugin/direct-config';
import { INSTALL_CLIENTS, installClientLabel, type InstallClient } from '@/lib/plugin/clients';

type TabKey = 'auto-sync' | 'direct';

const CLIENTS = DIRECT_CLIENTS.map((key) => ({ key, label: directClientLabel(key) }));
const INSTALLERS = INSTALL_CLIENTS.map((key) => ({ key, label: installClientLabel(key) }));

const pillGroup =
  'flex flex-wrap items-center gap-1';
const codeBlock =
  'overflow-x-auto whitespace-pre rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground';

export function ToolkitInstall({
  installUrl,
  uninstallUrl,
  mcpUrl,
  toolkitSlug,
  installationKey,
  serverCount,
  skillCount,
}: {
  installUrl: string;
  uninstallUrl: string;
  mcpUrl: string;
  toolkitSlug: string;
  installationKey?: string;
  serverCount: number;
  skillCount: number;
}) {
  const t = useTranslations('console.toolkits');
  const [tab, setTab] = useState<TabKey>('auto-sync');
  const [autoClient, setAutoClient] = useState<InstallClient>('claude-code');
  const [client, setClient] = useState<DirectClient>('claude-code');

  // Opaque, tokenless install link (the id is the only secret). The server
  // returns a bootstrap; executing it registers a scoped per-device credential.
  const autoInstallUrl = `${installUrl}${installUrl.includes('?') ? '&' : '?'}client=${autoClient}`;
  const autoSyncCmd = `curl -fsSL "${autoInstallUrl}" | bash`;
  const uninstallCmd = `curl -fsSL "${uninstallUrl}${uninstallUrl.includes('?') ? '&' : '?'}client=${autoClient}" | bash`;
  const directSnippet = buildDirectSnippet(client, installationKey ?? toolkitSlug, mcpUrl);
  const autoDescription =
    autoClient === 'codex'
      ? t('codexAutoSyncDescription')
      : autoClient === 'hermes'
        ? t('hermesAutoSyncDescription')
      : autoClient === 'opencode'
        ? t('openCodeAutoSyncDescription')
        : t('claudeAutoSyncDescription');

  return (
    <div className="rounded-lg border border-border bg-card p-4 border-border bg-card">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={pillGroup}>
          <Button onClick={() => setTab('auto-sync')} type="button" variant={tab === 'auto-sync' ? 'primary' : 'ghost'} size="sm">
            <RefreshCw className="size-3.5" />
            {t('autosync')}
          </Button>
          <Button onClick={() => setTab('direct')} type="button" variant={tab === 'direct' ? 'primary' : 'ghost'} size="sm">
            <Link2 className="size-3.5" />
            {t('directConnection')}
          </Button>
        </div>
        {tab === 'auto-sync' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('client')}
            </span>
            <div className={pillGroup}>
              {INSTALLERS.map((c) => (
                <Button key={c.key} onClick={() => setAutoClient(c.key)} type="button" variant={autoClient === c.key ? 'primary' : 'ghost'} size="sm">
                  {c.label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('client')}
            </span>
            <div className={pillGroup}>
              {CLIENTS.map((c) => (
                <Button key={c.key} onClick={() => setClient(c.key)} type="button" variant={client === c.key ? 'primary' : 'ghost'} size="sm">
                  {c.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      {tab === 'auto-sync' ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">
                {t('autosyncFor')} {installClientLabel(autoClient)}.
              </span>{' '}
              {autoDescription} {t('containsSummary', { serverCount, skillCount })}
            </p>
            <CopyButton text={autoSyncCmd} label={t('copy')} />
          </div>
          <pre className={codeBlock}>{autoSyncCmd}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('pasteThisInYourTerminalToInstallNoTokenNeededTheLinkMintsAPrivateApiTokenFor')} {installClientLabel(autoClient)}{t('soKeepItSecret')}{' '}
            <a
              href={autoInstallUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              {t('inspectTheScriptFirst')} <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">
                {t('directConnection1')}
              </span>{' '}
              {t('addTheToolkitapossMcpEndpointTo')} {directClientLabel(client)} {t('manually')}
            </p>
            <CopyButton text={directSnippet} label={t('copy')} />
          </div>
          <p className="mb-2 text-xs font-medium text-(--color-warning) dark:text-(--color-warning)">
            {t('directConnectionsExposeMcpToolsOnlyUseAutosyncToSyncSkillsToo')}
          </p>
          <pre className={codeBlock}>{directSnippet}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('endpoint')} <code className="font-mono break-all">{mcpUrl}</code>{t('replace')}{' '}
            <code className="font-mono">YOUR_TOKEN</code> {t('withAnApiTokenMcpMustBeRunningToExposeTheirTools')}
          </p>
        </div>
      )}

      <ToolkitInstallations mcpUrl={mcpUrl} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-primary pt-3 dark:border-primary">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('uninstall')}</span> {t('removesManagedClientConfigLocalSyncedSkillsAndAllInstallKeysForThisToolkit')}
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground">
            {uninstallCmd}
          </code>
          <CopyButton text={uninstallCmd} label={t('copy')} />
        </div>
      </div>
    </div>
  );
}
