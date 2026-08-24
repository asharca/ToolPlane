'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { RefreshCw, Link2, ExternalLink } from 'lucide-react';
import { CopyButton } from './CopyButton';
import {
  buildDirectSnippet,
  DIRECT_CLIENTS,
  directClientLabel,
  type DirectClient,
} from '@/lib/plugin/direct-config';
import {
  INSTALL_CLIENTS,
  installClientLabel,
  type InstallClient,
} from '@/lib/plugin/clients';

type TabKey = 'auto-sync' | 'direct';

const CLIENTS = DIRECT_CLIENTS.map((key) => ({ key, label: directClientLabel(key) }));
const INSTALLERS = INSTALL_CLIENTS.map((key) => ({ key, label: installClientLabel(key) }));

const pillBase =
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors';
const pillActive = 'bg-background text-foreground shadow-sm ring-1 ring-border/60';
const pillIdle =
  'text-muted-foreground hover:bg-accent/60 hover:text-foreground';
const pillGroup =
  'inline-flex items-center gap-1 rounded-full border border-border bg-muted p-1';
const codeBlock =
  'overflow-x-auto whitespace-pre rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground';

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${pillBase} ${active ? pillActive : pillIdle}`}
    >
      {children}
    </button>
  );
}

export function ToolkitInstall({
  installUrl,
  uninstallUrl,
  mcpUrl,
  toolkitSlug,
  serverCount,
  skillCount,
}: {
  installUrl: string;
  uninstallUrl: string;
  mcpUrl: string;
  toolkitSlug: string;
  serverCount: number;
  skillCount: number;
}) {
  const t = useTranslations('console.toolkits');
  const [tab, setTab] = useState<TabKey>('auto-sync');
  const [autoClient, setAutoClient] = useState<InstallClient>('claude-code');
  const [client, setClient] = useState<DirectClient>('claude-code');

  // Opaque, tokenless install link (the id is the only secret). The server
  // mints a client-scoped token and returns the right installer.
  const autoInstallUrl = `${installUrl}${installUrl.includes('?') ? '&' : '?'}client=${autoClient}`;
  const autoSyncCmd = `curl -fsSL "${autoInstallUrl}" | bash`;
  const uninstallCmd = `curl -fsSL "${uninstallUrl}" | bash`;
  const directSnippet = buildDirectSnippet(client, toolkitSlug, mcpUrl);
  const autoDescription =
    autoClient === 'codex'
      ? t('codexAutoSyncDescription')
      : autoClient === 'hermes'
        ? t('hermesAutoSyncDescription')
      : autoClient === 'opencode'
        ? t('openCodeAutoSyncDescription')
        : t('claudeAutoSyncDescription');

  return (
    <div className="rounded-lg border border-sky-100 bg-sky-50 p-4 dark:border-sky-500/20 dark:bg-sky-500/10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={pillGroup}>
          <Pill active={tab === 'auto-sync'} onClick={() => setTab('auto-sync')}>
            <RefreshCw className="size-3.5" />
            {t('autosync')}
          </Pill>
          <Pill active={tab === 'direct'} onClick={() => setTab('direct')}>
            <Link2 className="size-3.5" />
            {t('directConnection')}
          </Pill>
        </div>
        {tab === 'auto-sync' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('client')}
            </span>
            <div className={pillGroup}>
              {INSTALLERS.map((c) => (
                <Pill
                  key={c.key}
                  active={autoClient === c.key}
                  onClick={() => setAutoClient(c.key)}
                >
                  {c.label}
                </Pill>
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
                <Pill key={c.key} active={client === c.key} onClick={() => setClient(c.key)}>
                  {c.label}
                </Pill>
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
              href={installUrl}
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
          <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            {t('directConnectionsExposeMcpToolsOnlyUseAutosyncToSyncSkillsToo')}
          </p>
          <pre className={codeBlock}>{directSnippet}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('endpoint')} <code className="font-mono break-all">{mcpUrl}</code>{t('replace')}{' '}
            <code className="font-mono">YOUR_TOKEN</code> {t('withAnApiTokenMcpMustBeRunningToExposeTheirTools')}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sky-100 pt-3 dark:border-sky-500/20">
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
