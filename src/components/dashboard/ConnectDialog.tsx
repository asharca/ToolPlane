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
      ? 'ui-button-primary ui-button-sm'
      : 'ui-button-secondary';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button type="button" className={trigger}>
          {variant === 'banner' ? <ArrowRight className="size-3.5" /> : null}
          {label ?? t('connectWith')}
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent aria-describedby={undefined} className="ui-panel w-full max-w-lg p-5 sm:!p-5">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {selected ? (
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowLeft className="size-3.5" />
                    {t('changeClient')}
                  </button>
                ) : null}
                <DialogTitle className="text-base font-semibold text-foreground">
                  {selectedLabel ?? t('installServer')}
                </DialogTitle>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  aria-label={t('close')}
                  className="ui-button-ghost ui-icon-button !size-8 !min-h-8"
                >
                  <X className="size-4" />
                </button>
              </DialogClose>
            </div>

            {selected ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('howToInstall')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(selected.howToKey)}
                </p>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 pr-12 font-mono text-xs text-foreground">
{selected.snippet(key, endpoint)}
                  </pre>
                  <button
                    type="button"
                    onClick={() => copy(selected.snippet(key, endpoint))}
                    className="ui-button-secondary ui-button-sm absolute right-2 top-2 !size-8 !min-h-8 !p-0"
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
                    className="rounded-lg border border-border px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:border-input hover:bg-muted"
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
