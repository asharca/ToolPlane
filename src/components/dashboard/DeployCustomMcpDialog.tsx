'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, AlertTriangle } from 'lucide-react';
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
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground';

export function DeployCustomMcpDialog({ slug }: { slug: string }) {
  const t = useTranslations('console.mcp');
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [runtimeFiles, setRuntimeFiles] = useState<RuntimeFileDraft[]>([]);
  const [runtimeFilesError, setRuntimeFilesError] = useState<string | null>(null);
  const [network, setNetwork] = useState<'isolated' | 'none'>('isolated');
  const [networkTouched, setNetworkTouched] = useState(false);
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

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ui-button-primary"
      >
        <Plus className="size-4" />
        {t('addCustomMcp')}
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="deploy-custom-mcp-title"
                className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="shrink-0 px-6 pt-6">
                  <div className="mb-1 flex items-center justify-between">
                    <h2 id="deploy-custom-mcp-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('deployCustomMcp')}</h2>
                    <button type="button" onClick={() => setOpen(false)} aria-label={t('cancel')} className="text-muted-foreground hover:text-foreground">
                      <X className="size-5" />
                    </button>
                  </div>
                </div>

                <form action={deployCustomServerAction} onSubmit={validateBeforeSubmit} className="flex min-h-0 flex-1 flex-col">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="source" value="config" />
                  <input type="hidden" name="runtimeFiles" value={JSON.stringify(runtimeFiles)} />

                  <div
                    data-testid="deploy-custom-mcp-scroll-area"
                    className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4"
                  >
                    <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>{t('mcpCanAccessYourDataAndExecuteArbitraryCodeOnlyInstallSourcesYouTrust')}</span>
                    </div>

                  <div>
                    <label htmlFor="config" className={labelCls}>{t('jsonConfig')}</label>
                    <details className="mb-2 rounded-md border border-zinc-200 dark:border-zinc-800">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
                        {t('jsonExamples')}
                      </summary>
                      <div className="space-y-3 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
                        <p className="text-xs leading-5 text-muted-foreground">{t('jsonExamplesHint')}</p>
                        {([
                          ['npxConfig', 'jsonExampleNpxConfig'],
                          ['npxGit', 'jsonExampleNpxGit'],
                          ['uvxGit', 'jsonExampleUvxGit'],
                          ['uv', 'jsonExampleUv'],
                          ['docker', 'jsonExampleDocker'],
                        ] as const).map(([key, label]) => (
                          <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2">
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
                        <p className="text-xs leading-5 text-muted-foreground">{t('jsonGitHint')}</p>
                      </div>
                    </details>
                    <textarea
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
                      <p id="config-error" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                        {configError}
                      </p>
                    ) : null}
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{t('jsonSingleServerHint')}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('jsonCommandHint')}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">/{slug}{t('mcp')}{slugPreview}</p>
                  </div>

                  <div className="space-y-2">
                    <details className="rounded-md border border-zinc-200 dark:border-zinc-800">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
                        {t('runtimeFilesOptional')}
                      </summary>
                      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
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

                  <McpNetworkModeControl
                    value={network}
                    onChange={(value) => {
                      setNetwork(value);
                      setNetworkTouched(true);
                    }}
                    warnAboutPackageInstall={configCommand !== 'docker'}
                  />
                  </div>

                  <div
                    data-testid="deploy-custom-mcp-footer"
                    className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <button type="button" onClick={() => setOpen(false)} className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">{t('cancel')}</button>
                    <SubmitButton pendingLabel={t('deploying')} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">{t('deploy')}</SubmitButton>
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
