'use client';
import { BouncyAccordion } from '@/components/motion/bouncy-accordion';

import { CenterMorphModal } from '@/components/motion/center-morph-modal';
import { CenterMorphModalTrigger } from '@/components/motion/center-morph-modal';
import { CenterMorphModalContent, CenterMorphModalClose } from '@/components/motion/center-morph-modal';

import { Button } from '@/components/motion/button';


import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, AlertTriangle, Plug } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';
import { mcpConfigErrorDetail, parseMcpJsonConfig } from '@/lib/workspace/custom-mcp';
import { McpNetworkModeControl } from './McpNetworkModeControl';
import { RuntimeFileDraftsInput, runtimeFilePathKey, type RuntimeFileDraft } from './RuntimeFileDraftsInput';
import { SubmitButton } from './SubmitButton';
import { RemoteMcpTransportNotice } from './RemoteMcpTransportNotice';

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
  remoteHttp: `{
  "mcpServers": {
    "remote-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}`,
} as const;



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
  
  
  const configRef = useRef<HTMLTextAreaElement>(null);
  
  const parsedConfig = useMemo(() => {
    if (!config.trim()) return null;
    try {
      const parsed = parseMcpJsonConfig(config);
      return {
        name: parsed.name,
        source: parsed.source,
        ref: parsed.ref,
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
  const configIsRemote = parsedConfig?.source === 'remote';

  const setJsonConfig = (nextConfig: string) => {
    setConfig(nextConfig);
    setConfigError(null);
    if (!networkTouched) {
      try {
        const parsed = parseMcpJsonConfig(nextConfig);
        setNetwork(parsed.installCfg && 'network' in parsed.installCfg && parsed.installCfg.network === 'none' ? 'none' : 'isolated');
      } catch {
        // Example JSON is valid, but preserve the current selection defensively.
      }
    }
  };

  const validateBeforeSubmit = (event: FormEvent<HTMLFormElement>) => {
    try {
      parseMcpJsonConfig(config);
      setConfigError(null);
    } catch (error) {
      event.preventDefault();
      setConfigError(mcpConfigErrorDetail(error) ?? t('invalidJsonConfig'));
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
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
      <Button type="button" variant="primary" size="md"><Plus className="size-4" />
      {t('addCustomMcp')}</Button>
      </CenterMorphModalTrigger>

      <CenterMorphModalContent ariaLabel={t('deployCustomMcp')} ariaDescribedBy="deploy-custom-mcp-description" closeButtonLabel={t('cancel')} className="flex max-h-[calc(100dvh-4rem)] w-full max-w-2xl flex-col">
                <div className="flex shrink-0 items-start gap-4 border-b border-border pl-5 pr-16 py-5 sm:pl-6">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                      <Plug className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <h2 id="deploy-custom-mcp-title" className="text-lg font-semibold tracking-tight text-foreground">{t('deployCustomMcp')}</h2>
                      <p id="deploy-custom-mcp-description" className="mt-1 text-sm text-muted-foreground">
                        {t('jsonSingleServerHint')}
                      </p>
                    </div>
                  </div>
                </div>

                <form action={deployCustomServerAction} onSubmit={validateBeforeSubmit} className="flex min-h-0 flex-1 flex-col">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="source" value="config" />
                  <input type="hidden" name="runtimeFiles" value={JSON.stringify(configIsRemote ? [] : runtimeFiles)} />

                  <div
                    data-testid="deploy-custom-mcp-scroll-area"
                    className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6"
                  >
                    <div className="flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-foreground">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>{t('mcpCanAccessYourDataAndExecuteArbitraryCodeOnlyInstallSourcesYouTrust')}</span>
                    </div>

                      <section className="min-w-0 space-y-3">
                        <header>
                          <div className="min-w-0">
                            <label htmlFor="config" className="block text-sm font-semibold text-foreground">{t('jsonConfig')}</label>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('jsonCommandHint')}</p>
                          </div>
                        </header>
                        <div className="space-y-3">
                          <textarea autoFocus ref={configRef} id="config" name="config" required value={config} onChange={(event) => setJsonConfig(event.target.value)} placeholder={JSON_CONFIG_EXAMPLES.npxConfig} spellCheck={false} aria-invalid={Boolean(configError)} aria-describedby={configError ? 'config-error' : undefined} className="min-h-52 w-full resize-y rounded-xl border border-border bg-muted/35 p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                          {configName ? <p className="text-xs text-muted-foreground">{t('serverColumn')}: <span className="font-medium text-foreground">{configName}</span></p> : null}
                          {configIsRemote ? <RemoteMcpTransportNotice url={parsedConfig?.ref} showHelp /> : null}
                          {configError ? (
                            <p id="config-error" role="alert" className="text-xs text-destructive dark:text-destructive">
                              {configError}
                            </p>
                          ) : null}
                          <BouncyAccordion items={[{ id: 'details', title: <>{t('jsonExamples')}</>, description: <><div className="space-y-3 border-t border-border px-3 py-3">
                              <p className="text-xs leading-5 text-muted-foreground">{t('jsonExamplesHint')}</p>
                              {([
                                ['npxConfig', 'jsonExampleNpxConfig'],
                                ['npxGit', 'jsonExampleNpxGit'],
                                ['uvxGit', 'jsonExampleUvxGit'],
                                ['uv', 'jsonExampleUv'],
                                ['docker', 'jsonExampleDocker'],
                                ['remoteHttp', 'jsonExampleRemoteHttp'],
                              ] as const).map(([key, label]) => (
                                <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
                                  <span className="text-xs font-medium text-foreground">{t(label)}</span>
                                  <Button type="button" onClick={() => setJsonConfig(JSON_CONFIG_EXAMPLES[key])} variant="secondary" size="sm">{t('useJsonExample')}</Button>
                                </div>
                              ))}
                              <p className="text-xs leading-5 text-muted-foreground">{jsonGitHint}</p>
                            </div></> }]} />
                        </div>
                      </section>


                  {!configIsRemote ? (
                    <>
                      <div className="space-y-2">
                        <BouncyAccordion items={[{ id: 'details', title: <>{t('runtimeFilesOptional')}</>, description: <><div className="border-t border-border p-3">
                            <p className="mb-3 text-xs leading-5 text-muted-foreground">{t('runtimeFilesOptionalHint')}</p>
                            <RuntimeFileDraftsInput
                              value={runtimeFiles}
                              relativePathArgumentsWork={configCommand !== 'docker'}
                              onChange={(files) => {
                                setRuntimeFiles(files);
                                setRuntimeFilesError(null);
                              }}
                            />
                          </div></> }]} />
                        {runtimeFilesError ? (
                          <p className="text-xs text-destructive dark:text-destructive" role="alert">
                            {runtimeFilesError}
                          </p>
                        ) : null}
                      </div>

                      <BouncyAccordion items={[{
                        id: 'network',
                        title: `${t('networkMode')}: ${network === 'none' ? t('networkNone') : t('networkIsolated')}`,
                        description: (
                          <McpNetworkModeControl
                            value={network}
                            onChange={(value) => {
                              setNetwork(value);
                              setNetworkTouched(true);
                            }}
                            warnAboutPackageInstall={configCommand !== 'docker'}
                          />
                        ),
                      }]} />
                    </>
                  ) : null}
                  </div>

                  <div
                    data-testid="deploy-custom-mcp-footer"
                    className="flex shrink-0 justify-end gap-2 border-t border-border bg-card px-5 py-4 sm:px-6"
                  >
                    <CenterMorphModalClose><Button type="button" variant="secondary" size="sm">{t('cancel')}</Button></CenterMorphModalClose>
                    <SubmitButton pendingLabel={t('deploying')} variant="primary" size="sm">{t('deploy')}</SubmitButton>
                  </div>
                </form>
              </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
