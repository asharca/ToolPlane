'use client';

import { useState } from 'react';

type TabId = 'claude' | 'cursor' | 'codex';

const TABS: { id: TabId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor / JSON' },
  { id: 'codex', label: 'Codex CLI' },
];

function snippet(tab: TabId, endpoint: string): string {
  switch (tab) {
    case 'claude':
      return `claude mcp add --transport http mcpmarket \\
  ${endpoint} \\
  --header "Authorization: Bearer YOUR_TOKEN"`;
    case 'cursor':
      return `{
  "mcpServers": {
    "mcpmarket": {
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}`;
    case 'codex':
      return `[mcp_servers.mcpmarket]
url = "${endpoint}"
http_headers = { "Authorization" = "Bearer YOUR_TOKEN" }`;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function HubConnect({ endpoint }: { endpoint: string }) {
  const [tab, setTab] = useState<TabId>('claude');
  const code = snippet(tab, endpoint);

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connect your agent</h2>
        <p className="text-sm text-muted-foreground">
          Point any MCP client at your Hub endpoint and authenticate with an API
          token from your account.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="truncate font-mono text-sm text-foreground">{endpoint}</code>
        <CopyButton text={endpoint} />
      </div>

      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`h-8 rounded-md px-3 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <div className="absolute right-2 top-2">
          <CopyButton text={code} />
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 pr-16 text-xs leading-relaxed text-foreground">
          <code className="font-mono">{code}</code>
        </pre>
      </div>

      <p className="text-xs text-muted-foreground">
        Replace <code className="font-mono">YOUR_TOKEN</code> with a token created
        on your{' '}
        <a href="/account" className="font-medium text-foreground underline">
          account page
        </a>
        .
      </p>
    </section>
  );
}
