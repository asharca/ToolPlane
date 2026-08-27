'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, AlertTriangle, Plug } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';
import { parseMcpJsonConfig } from '@/lib/workspace/custom-mcp';
import { McpNetworkModeControl } from './McpNetworkModeControl';
import {
  RuntimeFileDraftsInput,
  runtimeFilePathKey,
  type RuntimeFileDraft,
} from './RuntimeFileDraftsInput';
import { SubmitButton } from './SubmitButton';

const JSON_CONFIG_EXAMPLES = {
  npxConfig: `{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--config-file", "ssh-config.json"
      ]
    }
  }
}`,
  npxGit: `{
  "mcpServers": {
    "git-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "git+https://git.example.com/group/repository.git#v1.0.0",
        "--config-file", "mcp-config.json"
      ]
    }
  }
}`,
  uvxGit: `{
  "mcpServers": {
    "uvx-git-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://git.example.com/group/repository.git@v1.0.0",
        "repository-mcp",
        "--config", "mcp-config.toml"
      ]
    }
  }
}`,
  uv: `{
  "mcpServers": {
    "uv-mcp": {
      "command": "uv",
      "args": [
        "run",
        "--with", "your-mcp-package",
        "your-mcp-command",
        "--config", "mcp-config.toml"
      ]
    }
  }
}`,
  docker: `{
  "mcpServers": {
    "container-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "registry.example.com/organization/mcp-server:latest",
        "--config", "/toolplane/config/mcp-config.json"
      ]
    }
  }
}`,
} as const;

const field =
  'w-full rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/15';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground';
const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function DeployCustomMcpDialog({
  slug,
  defaultOpen = false,
}: {
  slug: string;
  defaultOpen?: boolean;
}) {
  const t = useTranslations('console.mcp');
  // `jsonGitHint` includes URL placeholders such as `<host>`. Read it as raw
  // text so next-intl does not interpret those placeholders as rich-text tags.
  const jsonGitHint = typeof t.raw === 'function'
    ? String(t.raw('jsonGitHint'))
    : t('jsonGitHint');
  const [open, setOpen] = useState(defaultOpen);
  const [config, setConfig] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [runtimeFiles, setRuntimeFiles] = useState<RuntimeFileDraft[]>([]);
  const [runtimeFilesError, setRuntimeFilesError] = useState<string | null>(null);
  const [network, setNetwork] = useState<'isolated' | 'none'>('isolated');
  const [networkTouched, setNetworkTouched] = useState(false);
  const mounted = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const configRef = useRef<HTMLTextAreaElement>(null);
  const restoreTriggerFocus = useRef(false);
  const parsedConfig = useMemo(() => {
    if (!config.trim()) return null;
    try {
      const parsed = parseMcpJsonConfig(config);
      return {
        name: parsed.name,
        command: parsed.installCfg && 'command' in parsed.installCfg
          ? parsed.installCfg.command
          : null,
      };
    } catch {
      return null;
    }
  }, [config]);
  const configName = parsedConfig?.name ?? '';
  const configCommand = parsedConfig?.command;
  const slugPreview =
    configName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server';

  const setJsonConfig = (nextConfig: string) => {
    setConfig(nextConfig);
    setConfigError(null);
    if (!networkTouched) {
      try {
        const parsed = parseMcpJsonConfig(nextConfig);
        setNetwork(parsed.installCfg?.network === 'none' ? 'none' : 'isolated');
      } catch {
        // Example JSON is valid, but preserve the current selection defensively.
      }
    }
  };

  const validateBeforeSubmit = (event: FormEvent<HTMLFormElement>) => {
    try {
      parseMcpJsonConfig(config);
      setConfigError(null);
    } catch {
      event.preventDefault();
      setConfigError(t('invalidJsonConfig'));
      return;
    }
    const runtimeFileKeys = new Set<string>();
    const invalidRuntimeFile = runtimeFiles.some(({ path, content }) => {
      const value = path;
      const parts = value.split('/');
      const invalidPath = !value
        || value !== value.trim()
        || value.startsWith('/')
        || value.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(value)
        || parts.some((part) => !part || part === '.' || part === '..');
      if (invalidPath || content.includes('\0')) return true;

      const key = runtimeFilePathKey(value);
      if (!key || runtimeFileKeys.has(key)) return true;
      runtimeFileKeys.add(key);
      return false;
    });
    if (invalidRuntimeFile) {
      event.preventDefault();
      setRuntimeFilesError(t('invalidRuntimeFile'));
    } else {
      setRuntimeFilesError(null);
    }
  };

  const closeDialog = () => {
    restoreTriggerFocus.current = true;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      if (restoreTriggerFocus.current) {
        restoreTriggerFocus.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    configRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="ui-button-primary"
      >
        <Plus className="size-4" />
        {t('addCustomMcp')}
      </button>

      {open && mounted
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-[1px]" onClick={closeDialog}>
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="deploy-custom-mcp-title"
                aria-describedby="deploy-custom-mcp-description"
                className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-gradient-to-r from-brand-soft/70 to-transparent px-5 py-5 sm:px-6">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
                      <Plug className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <h2 id="deploy-custom-mcp-title" className="text-lg font-semibold tracking-tight text-foreground">{t('deployCustomMcp')}</h2>
                      <p id="deploy-custom-mcp-description" className="mt-1 text-sm text-muted-foreground">
                        {t('jsonSingleServerHint')}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeDialog}
                    aria-label={t('cancel')}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                      <X className="size-5" />
                  </button>
                </div>

                <form action={deployCustomServerAction} onSubmit={validateBeforeSubmit} className="flex min-h-0 flex-1 flex-col">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="source" value="config" />
                  <input type="hidden" name="runtimeFiles" value={JSON.stringify(runtimeFiles)} />

                  <div
                    data-testid="deploy-custom-mcp-scroll-area"
                    className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6"
                  >
                    <div className="flex gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>{t('mcpCanAccessYourDataAndExecuteArbitraryCodeOnlyInstallSourcesYouTrust')}</span>
                    </div>

                    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_12.5rem]">
                      <section className="min-w-0 rounded-lg border border-border bg-card">
                        <header className="flex items-start gap-3 border-b border-border px-4 py-3.5">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand">1</span>
                          <div className="min-w-0">
                            <label htmlFor="config" className="block text-sm font-semibold text-foreground">{t('jsonConfig')}</label>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('jsonCommandHint')}</p>
                          </div>
                        </header>
                        <div className="space-y-3 p-4">
                          <details className="rounded-md border border-border bg-muted/20">
                            <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-foreground marker:text-muted-foreground">
                              {t('jsonExamples')}
                            </summary>
                            <div className="space-y-3 border-t border-border px-3 py-3">
                              <p className="text-xs leading-5 text-muted-foreground">{t('jsonExamplesHint')}</p>
                              {([
                                ['npxConfig', 'jsonExampleNpxConfig'],
                                ['npxGit', 'jsonExampleNpxGit'],
                                ['uvxGit', 'jsonExampleUvxGit'],
                                ['uv', 'jsonExampleUv'],
                                ['docker', 'jsonExampleDocker'],
                              ] as const).map(([key, label]) => (
                                <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
                                  <span className="text-xs font-medium text-foreground">{t(label)}</span>
                                  <button
                                    type="button"
                                    onClick={() => setJsonConfig(JSON_CONFIG_EXAMPLES[key])}
                                    className="ui-button-secondary ui-button-sm"
                                  >
                                    {t('useJsonExample')}
                                  </button>
                                </div>
                              ))}
                              <p className="text-xs leading-5 text-muted-foreground">{jsonGitHint}</p>
                            </div>
                          </details>
                          <textarea
                            ref={configRef}
                            id="config"
                            name="config"
                            required
                            value={config}
                            onChange={(event) => setJsonConfig(event.target.value)}
                            placeholder={JSON_CONFIG_EXAMPLES.npxConfig}
                            spellCheck={false}
                            aria-invalid={Boolean(configError)}
                            aria-describedby={configError ? 'config-error' : undefined}
                            className={`${field} min-h-48 resize-y py-3 font-mono text-xs leading-5`}
                          />
                          {configError ? (
                            <p id="config-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
                              {configError}
                            </p>
                          ) : null}
                        </div>
                      </section>

                      <aside className="space-y-3">
                        <section className="rounded-lg border border-border bg-muted/30 p-3.5">
                          <p className={labelCls}>{t('endpoint')}</p>
                          <code className="block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground">
                            /{slug}{t('mcp')}{slugPreview}
                          </code>
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">
                            {configName || t('configuration')}
                          </p>
                        </section>
                      </aside>
                    </div>

                  <div className="space-y-2">
                    <details className="rounded-lg border border-border bg-card">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
                        {t('runtimeFilesOptional')}
                      </summary>
                      <div className="border-t border-border p-3">
                        <p className="mb-3 text-xs leading-5 text-muted-foreground">{t('runtimeFilesOptionalHint')}</p>
                        <RuntimeFileDraftsInput
                          value={runtimeFiles}
                          relativePathArgumentsWork={configCommand !== 'docker'}
                          onChange={(files) => {
                            setRuntimeFiles(files);
                            setRuntimeFilesError(null);
                          }}
                        />
                      </div>
                    </details>
                    {runtimeFilesError ? (
                      <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                        {runtimeFilesError}
                      </p>
                    ) : null}
                  </div>

                    <section className="rounded-lg border border-border bg-card p-4">
                      <McpNetworkModeControl
                        value={network}
                        onChange={(value) => {
                          setNetwork(value);
                          setNetworkTouched(true);
                        }}
                        warnAboutPackageInstall={configCommand !== 'docker'}
                      />
                    </section>
                  </div>

                  <div
                    data-testid="deploy-custom-mcp-footer"
                    className="flex shrink-0 justify-end gap-2 border-t border-border bg-card px-5 py-4 sm:px-6"
                  >
                    <button type="button" onClick={closeDialog} className="ui-button-secondary h-9 px-4">{t('cancel')}</button>
                    <SubmitButton pendingLabel={t('deploying')} className="ui-button-primary h-9 px-4">{t('deploy')}</SubmitButton>
                  </div>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
