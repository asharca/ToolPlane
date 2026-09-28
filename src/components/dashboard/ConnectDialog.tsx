'use client';
import { CenterMorphModal, CenterMorphModalTrigger, CenterMorphModalContent } from '@/components/motion/center-morph-modal';
import { Button } from '@/components/motion/button';


import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ArrowRight, ArrowLeft, Copy, Check } from 'lucide-react';

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

  

  return (
    <CenterMorphModal open={open} onOpenChange={handleOpenChange}>
      <CenterMorphModalTrigger>
        <Button type="button" variant={variant === "banner" ? "primary" : "secondary"} size="md">{variant === 'banner' ? <ArrowRight className="size-3.5" /> : null}
        {label ?? t('connectWith')}</Button>
      </CenterMorphModalTrigger>

      
        
        <CenterMorphModalContent ariaLabel={selectedLabel ?? t('installServer')} closeButtonLabel={t('close')} className="w-full max-w-xl p-6">
          <div>
            <div className="mb-4 flex items-center pr-10">
              <div className="flex items-center gap-2">
                {selected ? (
                  <Button type="button" onClick={() => setSelected(null)} variant="ghost" size="md" className="inline-flex items-center"><ArrowLeft className="size-3.5" />
                  {t('changeClient')}</Button>
                ) : null}
                <h2 className="text-base font-semibold text-foreground">
                  {selectedLabel ?? t('installServer')}
                </h2>
              </div>
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
                  <Button type="button" onClick={() => copy(selected.snippet(key, endpoint))} aria-label={t('copySnippet')} variant="secondary" size="icon" className="absolute right-2 top-2">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CLIENTS.map((c) => (
                  <Button key={c.id} type="button" onClick={() => {
                    setSelected(c);
                    setCopied(false);
                  }} variant="secondary" size="md" className="text-left">{c.labelKey ? t(c.labelKey) : c.label}</Button>
                ))}
              </div>
            )}
          </div>
        </CenterMorphModalContent>
      
    </CenterMorphModal>
  );
}
