'use client';

import { useState } from 'react';
import { ArrowRight, ArrowLeft, X, Copy, Check } from 'lucide-react';

type Client = {
  id: string;
  label: string;
  howTo: string;
  snippet: (key: string, endpoint: string) => string;
};

function jsonConfig(key: string, endpoint: string): string {
  return `{
  "mcpServers": {
    "${key}": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}`;
}

const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    howTo: 'Run in your terminal:',
    snippet: (key, endpoint) =>
      `claude mcp add --transport http "${key}" "${endpoint}" \\\n  --header "Authorization: Bearer <API_TOKEN>"`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    howTo: 'Add to your claude_desktop_config.json:',
    snippet: jsonConfig,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    howTo: 'Add to ~/.cursor/mcp.json:',
    snippet: jsonConfig,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    howTo: 'Add to .vscode/mcp.json:',
    snippet: (key, endpoint) =>
      `{
  "servers": {
    "${key}": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}`,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    howTo: 'Run in your terminal:',
    snippet: (key, endpoint) =>
      `codex mcp add "${key}" --transport http --url "${endpoint}" \\\n  --header "Authorization: Bearer <API_TOKEN>"`,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    howTo: 'Add to ~/.codeium/windsurf/mcp_config.json:',
    snippet: jsonConfig,
  },
  {
    id: 'cline',
    label: 'Cline',
    howTo: 'Add to cline_mcp_settings.json:',
    snippet: jsonConfig,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    howTo: 'Add to ~/.gemini/settings.json:',
    snippet: jsonConfig,
  },
  {
    id: 'url',
    label: 'Connection URL',
    howTo: 'Use this URL in any MCP client:',
    snippet: (_key, endpoint) => endpoint,
  },
];

export function ConnectDialog({
  endpoint,
  name,
  label = 'Connect with…',
  variant = 'banner',
}: {
  endpoint: string;
  name: string;
  label?: string;
  variant?: 'banner' | 'outline';
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Client | null>(null);
  const [copied, setCopied] = useState(false);

  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';

  function close() {
    setOpen(false);
    setSelected(null);
    setCopied(false);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  }

  const trigger =
    variant === 'banner'
      ? 'inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200'
      : 'inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={trigger}>
        {variant === 'banner' ? <ArrowRight className="size-3.5" /> : null}
        {label}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 bg-black/50"
          />
          <div
            role="dialog"
            aria-label={selected ? selected.label : 'Install server'}
            className="relative z-10 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {selected ? (
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    <ArrowLeft className="size-3.5" />
                    Change client
                  </button>
                ) : null}
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {selected ? selected.label : 'Install server'}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X className="size-4" />
              </button>
            </div>

            {selected ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  How to install
                </p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {selected.howTo}
                </p>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 pr-12 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
{selected.snippet(key, endpoint)}
                  </pre>
                  <button
                    type="button"
                    onClick={() => copy(selected.snippet(key, endpoint))}
                    className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    aria-label="Copy snippet"
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CLIENTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelected(c);
                      setCopied(false);
                    }}
                    className="rounded-lg border border-zinc-200 px-3 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
