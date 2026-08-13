'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ArrowRight, ArrowLeft, X, Copy, Check } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';

type Client = {
  id: string;
  label: string;
  labelKey?: 'connectionUrl';
  howToKey:
    | 'runInTerminal'
    | 'addToClaudeDesktopConfig'
    | 'addToCursorConfig'
    | 'addToVsCodeConfig'
    | 'addToCodexConfig'
    | 'addToOpenCodeConfig'
    | 'addToWindsurfConfig'
    | 'addToClineConfig'
    | 'addToGeminiConfig'
    | 'useUrlInAnyMcpClient';
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
    howToKey: 'runInTerminal',
    snippet: (key, endpoint) =>
      `claude mcp add --transport http "${key}" "${endpoint}" \\\n  --header "Authorization: Bearer <API_TOKEN>"`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    howToKey: 'addToClaudeDesktopConfig',
    snippet: jsonConfig,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    howToKey: 'addToCursorConfig',
    snippet: jsonConfig,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    howToKey: 'addToVsCodeConfig',
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
    howToKey: 'addToCodexConfig',
    snippet: (key, endpoint) =>
      [
        `[mcp_servers.${key}]`,
        `url = "${endpoint}"`,
        'http_headers = { Authorization = "Bearer <API_TOKEN>" }',
      ].join('\n'),
  },
  {
    id: 'opencode',
    label: 'opencode',
    howToKey: 'addToOpenCodeConfig',
    snippet: (key, endpoint) =>
      [
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "mcp": {',
        `    "${key}": {`,
        '      "type": "remote",',
        `      "url": "${endpoint}",`,
        '      "enabled": true,',
        '      "oauth": false,',
        '      "headers": { "Authorization": "Bearer <API_TOKEN>" }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    howToKey: 'addToWindsurfConfig',
    snippet: jsonConfig,
  },
  {
    id: 'cline',
    label: 'Cline',
    howToKey: 'addToClineConfig',
    snippet: jsonConfig,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    howToKey: 'addToGeminiConfig',
    snippet: jsonConfig,
  },
  {
    id: 'url',
    label: 'Connection URL',
    labelKey: 'connectionUrl',
    howToKey: 'useUrlInAnyMcpClient',
    snippet: (_key, endpoint) => endpoint,
  },
];

export function ConnectDialog({
  endpoint,
  name,
  label,
  variant = 'banner',
}: {
  endpoint: string;
  name: string;
  label?: string;
  variant?: 'banner' | 'outline';
}) {
  const t = useTranslations('console.common');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Client | null>(null);
  const [copied, setCopied] = useState(false);

  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
  const selectedLabel = selected
    ? selected.labelKey ? t(selected.labelKey) : selected.label
    : null;

  function close() {
    setOpen(false);
    setSelected(null);
    setCopied(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setOpen(true);
    } else {
      close();
    }
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button type="button" className={trigger}>
          {variant === 'banner' ? <ArrowRight className="size-3.5" /> : null}
          {label ?? t('connectWith')}
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay className="bg-black/50" />
        <DialogContent aria-describedby={undefined} className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-xl sm:!p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {selected ? (
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    <ArrowLeft className="size-3.5" />
                    {t('changeClient')}
                  </button>
                ) : null}
                <DialogTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {selectedLabel ?? t('installServer')}
                </DialogTitle>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  aria-label={t('close')}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
                >
                  <X className="size-4" />
                </button>
              </DialogClose>
            </div>

            {selected ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  {t('howToInstall')}
                </p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {t(selected.howToKey)}
                </p>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 pr-12 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
{selected.snippet(key, endpoint)}
                  </pre>
                  <button
                    type="button"
                    onClick={() => copy(selected.snippet(key, endpoint))}
                    className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    aria-label={t('copySnippet')}
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
                    {c.labelKey ? t(c.labelKey) : c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
