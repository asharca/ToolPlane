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
const pillActive = 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100';
const pillIdle =
  'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';
const pillGroup =
  'inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white/60 p-1 dark:border-zinc-700 dark:bg-zinc-900/60';
const codeBlock =
  'overflow-x-auto whitespace-pre rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200';

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
      ? 'Configures Codex MCP, installs a SessionStart sync hook, and syncs skills into your user skills folder.'
      : autoClient === 'hermes'
        ? 'Configures Hermes MCP, syncs skills into ~/.hermes/skills/toolplane, and writes a Hermes skill bundle.'
      : autoClient === 'opencode'
        ? 'Configures opencode remote MCP and a toolkit command backed by synced local skill files.'
        : 'Installs as one Claude Code plugin with MCP tools, synced skills, and skill telemetry hooks.';

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
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
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
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
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
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                {t('autosyncFor')} {installClientLabel(autoClient)}.
              </span>{' '}
              {autoDescription} {t('containsSummary', { serverCount, skillCount })}
            </p>
            <CopyButton text={autoSyncCmd} label={t('copy')} />
          </div>
          <pre className={codeBlock}>{autoSyncCmd}</pre>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
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
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
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
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            {t('endpoint')} <code className="font-mono break-all">{mcpUrl}</code>{t('replace')}{' '}
            <code className="font-mono">YOUR_TOKEN</code> {t('withAnApiTokenMcpMustBeRunningToExposeTheirTools')}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sky-100 pt-3 dark:border-sky-500/20">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{t('uninstall')}</span> {t('removesManagedClientConfigLocalSyncedSkillsAndAllInstallKeysForThisToolkit')}
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-white/70 px-2 py-1 font-mono text-[11px] text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            {uninstallCmd}
          </code>
          <CopyButton text={uninstallCmd} label={t('copy')} />
        </div>
      </div>
    </div>
  );
}
