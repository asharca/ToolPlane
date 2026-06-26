'use client';

import { useState, type ReactNode } from 'react';
import { RefreshCw, Link2, ExternalLink } from 'lucide-react';
import { CopyButton } from './CopyButton';

type Client = 'claude' | 'codex' | 'claude-code';
type TabKey = 'auto-sync' | 'direct';

const CLIENTS: { key: Client; label: string }[] = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'claude-code', label: 'Claude Code' },
];

function clientLabel(c: Client): string {
  return c === 'claude' ? 'Claude' : c === 'codex' ? 'Codex' : 'Claude Code';
}

// Manual MCP config per client for the "Direct connection" tab.
function buildDirectSnippet(client: Client, toolkitSlug: string, mcpUrl: string): string {
  if (client === 'claude-code') {
    return `claude mcp add --transport http "${toolkitSlug}" "${mcpUrl}" --header "Authorization: Bearer YOUR_TOKEN"`;
  }
  if (client === 'codex') {
    return [
      '# ~/.codex/config.toml',
      `[mcp_servers.${toolkitSlug}]`,
      `url = "${mcpUrl}"`,
      'http_headers = { Authorization = "Bearer YOUR_TOKEN" }',
    ].join('\n');
  }
  return [
    '// claude_desktop_config.json',
    '{',
    '  "mcpServers": {',
    `    "${toolkitSlug}": {`,
    `      "url": "${mcpUrl}",`,
    '      "headers": { "Authorization": "Bearer YOUR_TOKEN" }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

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
  const [tab, setTab] = useState<TabKey>('auto-sync');
  const [client, setClient] = useState<Client>('claude-code');

  // Opaque, tokenless install link (the id is the only secret); default client
  // needs no query param.
  const autoSyncUrl = client === 'claude-code' ? installUrl : `${installUrl}?client=${client}`;
  const autoSyncCmd = `curl -fsSL "${autoSyncUrl}" | bash`;
  const uninstallCmd = `curl -fsSL "${uninstallUrl}" | bash`;
  const directSnippet = buildDirectSnippet(client, toolkitSlug, mcpUrl);

  return (
    <div className="rounded-lg border border-sky-100 bg-sky-50 p-4 dark:border-sky-500/20 dark:bg-sky-500/10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={pillGroup}>
          <Pill active={tab === 'auto-sync'} onClick={() => setTab('auto-sync')}>
            <RefreshCw className="size-3.5" />
            Auto-sync
          </Pill>
          <Pill active={tab === 'direct'} onClick={() => setTab('direct')}>
            <Link2 className="size-3.5" />
            Direct connection
          </Pill>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Client
          </span>
          <div className={pillGroup}>
            {CLIENTS.map((c) => (
              <Pill key={c.key} active={client === c.key} onClick={() => setClient(c.key)}>
                {c.label}
              </Pill>
            ))}
          </div>
        </div>
      </div>

      {tab === 'auto-sync' ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                Installs as one plugin.
              </span>{' '}
              Every skill and MCP tool inside auto-syncs across {clientLabel(client)} —{' '}
              {serverCount} MCP server{serverCount === 1 ? '' : 's'}, {skillCount} skill
              {skillCount === 1 ? '' : 's'}.
            </p>
            <CopyButton text={autoSyncCmd} label="Copy" />
          </div>
          <pre className={codeBlock}>{autoSyncCmd}</pre>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Paste this in your terminal to install — no token needed. The link embeds a private
            API token, so keep it secret.{' '}
            <a
              href={autoSyncUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              Inspect the script first <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                Direct connection.
              </span>{' '}
              Add the toolkit&apos;s MCP endpoint to {clientLabel(client)} manually.
            </p>
            <CopyButton text={directSnippet} label="Copy" />
          </div>
          <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            Direct connections expose MCP tools only. Use Auto-sync to expose skills too.
          </p>
          <pre className={codeBlock}>{directSnippet}</pre>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Endpoint <code className="font-mono break-all">{mcpUrl}</code>. Replace{' '}
            <code className="font-mono">YOUR_TOKEN</code> with an API token. MCP servers must be
            running to expose their tools.
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sky-100 pt-3 dark:border-sky-500/20">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Uninstall</span> — removes
          the plugin (and its synced skills) from Claude Code and revokes its key:
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-white/70 px-2 py-1 font-mono text-[11px] text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            {uninstallCmd}
          </code>
          <CopyButton text={uninstallCmd} label="Copy" />
        </div>
      </div>
    </div>
  );
}
