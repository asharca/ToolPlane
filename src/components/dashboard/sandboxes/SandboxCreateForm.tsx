'use client';

import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useFormStatus } from 'react-dom';
import {
  Cable,
  Check,
  Container,
  Loader2,
  Network,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createSandboxAction } from '@/lib/sandboxes/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { HermesImageSelector } from '@/components/dashboard/agents/HermesImageSelector';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_IMAGE_OPTIONS,
  type SandboxImageOption,
} from '@/lib/sandboxes/images';
import { DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB } from '@/lib/agents/hermes/archive-limits';

type Mode = 'docker' | 'connector' | 'hermes-import';

type HermesImportState = {
  pending: boolean;
  phase?: 'uploading' | 'importing';
  uploadedBytes?: number;
  totalBytes?: number;
  error?: string;
};

const inputClass = 'ui-input h-9 w-full';
const recommendedImages = SANDBOX_IMAGE_OPTIONS.filter((option) => option.category === 'recommended');
const generalImages = SANDBOX_IMAGE_OPTIONS.filter((option) => option.category === 'general');

function hermesArchiveLimitLabel(maxUploadMiB: number): string {
  return maxUploadMiB >= 1024 && maxUploadMiB % 1024 === 0
    ? `${maxUploadMiB / 1024} GiB (${maxUploadMiB} MiB)`
    : `${maxUploadMiB} MiB`;
}

function newHermesImportId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function Field({
  label,
  children,
  className,
  hint,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  hint?: string;
}) {
  return (
    <label className={cx('space-y-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground', className)}>
      {label}
      {children}
      {hint ? <span className="block text-[11px] font-normal normal-case leading-4 tracking-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function ModeButton({
  active,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'group flex min-h-20 items-start gap-3 rounded-md border px-3 py-3 text-left transition-colors',
        active
          ? 'border-brand bg-brand-soft text-accent-foreground'
          : 'border-border bg-background text-foreground hover:border-ring/60 hover:bg-muted/50',
      )}
    >
      <span
        className={cx(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
          active ? 'border-brand/30 bg-background text-brand' : 'border-border bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function ImageCard({
  option,
  selected,
  onSelect,
}: {
  option: SandboxImageOption;
  selected: boolean;
  onSelect: (image: string) => void;
}) {
  return (
    <label
      className={cx(
        'group flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors',
        selected
          ? 'border-brand bg-brand-soft text-accent-foreground'
          : 'border-border bg-background hover:border-ring/60 hover:bg-muted/40',
      )}
    >
      <input
        type="radio"
        name="imageChoice"
        value={option.image}
        checked={selected}
        onChange={() => onSelect(option.image)}
        className="sr-only"
      />
      <span
        className={cx(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border',
          selected ? 'border-brand/30 bg-background text-brand' : 'border-border bg-muted text-muted-foreground',
        )}
      >
        {selected ? <Check className="size-3.5" /> : <Server className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{option.name}</span>
          <span className="rounded-md border border-border bg-muted/35 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {option.badge}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.summary}</span>
        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground/80">{option.image}</span>
        <span className="mt-2 block text-[11px] font-medium text-foreground">{option.bestFor}</span>
      </span>
    </label>
  );
}

function ImageGroup({
  title,
  description,
  options,
  selectedImage,
  onSelect,
}: {
  title: string;
  description: string;
  options: readonly SandboxImageOption[];
  selectedImage: string;
  onSelect: (image: string) => void;
}) {
  const t = useTranslations('console.sandboxes');
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">{options.length} {t('images')}</span>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {options.map((option) => (
          <ImageCard
            key={option.id}
            option={option}
            selected={selectedImage === option.image}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function CreateSandboxFooter({
  mode,
  hermesImport,
}: {
  mode: Mode;
  hermesImport: HermesImportState;
}) {
  const t = useTranslations('console.sandboxes');
  const { pending: actionPending } = useFormStatus();
  const isDocker = mode === 'docker';
  const isHermesImport = mode === 'hermes-import';
  const pending = isHermesImport ? hermesImport.pending : actionPending;
  const uploading = isHermesImport && hermesImport.phase === 'uploading';
  const percent = uploading && hermesImport.totalBytes
    ? Math.min(100, Math.round((hermesImport.uploadedBytes ?? 0) / hermesImport.totalBytes * 100))
    : null;

  const pendingTitle = isHermesImport
    ? uploading ? t('uploadingHermesArchive') : t('importingHermesArchive')
    : isDocker ? t('creatingSandboxRuntime') : t('creatingConnectorSandbox');
  const pendingDescription = isHermesImport
    ? uploading ? t('uploadingHermesArchiveDescription') : t('importingHermesArchiveDescription')
    : isDocker ? t('creatingSandboxRuntimeDescription') : t('creatingConnectorSandboxDescription');
  const pendingLabel = isHermesImport
    ? pendingTitle
    : isDocker ? t('creatingContainer') : t('creatingConnector');
  const submitLabel = isHermesImport
    ? t('importAndCreateHermesSandbox')
    : isDocker ? t('createContainer') : t('createConnector');

  return (
    <div className="sticky bottom-0 -mx-5 mt-5 border-t border-border bg-card/95 px-5 py-4 backdrop-blur">
      {pending ? (
        <div className="mb-3 rounded-md border border-brand/25 bg-brand-soft px-3 py-3" aria-live="polite">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="size-4 animate-spin" />
            {pendingTitle}{percent !== null ? ` ${percent}%` : ''}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {pendingDescription}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
            <div
              className={cx('h-full rounded-full bg-brand', percent === null && 'w-1/3 animate-pulse')}
              style={percent === null ? undefined : { width: `${Math.max(2, percent)}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="flex justify-end">
        {isHermesImport ? (
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className="ui-button-primary h-9 w-full disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-4" />}
            {pending ? pendingLabel : submitLabel}
          </button>
        ) : (
          <SubmitButton
            flash={false}
            pendingLabel={pendingLabel}
            className="ui-button-primary h-9 w-full sm:w-auto"
          >
            <Plus className="size-4" />
            {submitLabel}
          </SubmitButton>
        )}
      </div>
    </div>
  );
}

export function SandboxCreateForm({
  workspace,
  hermesArchiveMaxUploadMiB = DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  hermesImages,
}: {
  workspace: string;
  hermesArchiveMaxUploadMiB?: number;
  hermesImages?: string[];
}) {
  const [mode, setMode] = useState<Mode>('docker');
  const [selectedImage, setSelectedImage] = useState(DEFAULT_SANDBOX_IMAGE);
  const [customImage, setCustomImage] = useState('');
  const [open, setOpen] = useState(false);
  const [importState, setImportState] = useState<HermesImportState>({ pending: false });
  const hermesImportId = useRef<string | null>(null);
  const router = useRouter();
  const t = useTranslations('console.sandboxes');
  const isDocker = mode === 'docker';
  const isHermesImport = mode === 'hermes-import';
  const customSelected = selectedImage === 'custom';

  const submitHermesArchive = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (importState.pending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const archiveInput = form.elements.namedItem('hermesArchive');
    const archive = archiveInput instanceof HTMLInputElement ? archiveInput.files?.[0] : undefined;
    if (!archive || archive.size <= 0) {
      setImportState({ pending: false, error: t('chooseNonEmptyHermesArchive') });
      return;
    }
    const trustInput = form.elements.namedItem('trustArchive');
    if (!(trustInput instanceof HTMLInputElement) || !trustInput.checked) {
      setImportState({ pending: false, error: t('confirmTrustHermesArchive') });
      return;
    }
    const hermesImage = String(formData.get('hermesImage') ?? '').trim();

    const maxBytes = hermesArchiveMaxUploadMiB * 1024 * 1024;
    if (archive.size > maxBytes) {
      setImportState({
        pending: false,
        error: t('hermesArchiveTooLarge', { max: hermesArchiveMaxUploadMiB }),
      });
      return;
    }
    const importId = hermesImportId.current ??= newHermesImportId();

    setImportState({
      pending: true,
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes: archive.size,
    });

    try {
      const imported = await new Promise<{ agentId: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open(
          'POST',
          `/api/v1/workspaces/${encodeURIComponent(workspace)}/sandboxes/hermes-import`,
        );
        request.withCredentials = true;
        request.setRequestHeader('content-type', 'application/zip');
        request.setRequestHeader('x-toolplane-hermes-archive-trusted', '1');
        request.setRequestHeader('x-toolplane-hermes-archive-name', encodeURIComponent(archive.name));
        request.setRequestHeader('x-toolplane-hermes-import-id', importId);
        request.setRequestHeader(
          'x-toolplane-hermes-import-name',
          encodeURIComponent(String(formData.get('name') ?? '').trim()),
        );
        // The endpoint deliberately receives a raw ZIP body, so keep the
        // selected image in a separately encoded header. The server validates
        // it before using it as a Docker image reference.
        if (hermesImage) {
          request.setRequestHeader('x-toolplane-hermes-image', encodeURIComponent(hermesImage));
        }
        const allowSudoInput = form.elements.namedItem('allowSudo');
        if (allowSudoInput instanceof HTMLInputElement && allowSudoInput.checked) {
          request.setRequestHeader('x-toolplane-hermes-allow-sudo', '1');
        }
        request.upload.addEventListener('progress', (progress) => {
          setImportState({
            pending: true,
            phase: 'uploading',
            uploadedBytes: progress.loaded,
            totalBytes: progress.lengthComputable ? progress.total : archive.size,
          });
        });
        request.upload.addEventListener('load', () => {
          setImportState({
            pending: true,
            phase: 'importing',
            uploadedBytes: archive.size,
            totalBytes: archive.size,
          });
        });
        request.addEventListener('load', () => {
          let result: { agentId?: unknown; error?: unknown } = {};
          try {
            result = JSON.parse(request.responseText || '{}') as typeof result;
          } catch {
            // The generic status error below is safer than exposing an HTML proxy response.
          }
          if (
            request.status >= 200
            && request.status < 300
            && typeof result.agentId === 'string'
          ) {
            resolve({ agentId: result.agentId });
            return;
          }
          reject(new Error(
            typeof result.error === 'string' ? result.error : t('hermesArchiveImportFailed'),
          ));
        });
        request.addEventListener('error', () => {
          reject(new Error(t('hermesArchiveUploadInterrupted')));
        });
        request.addEventListener('abort', () => {
          reject(new Error(t('hermesArchiveUploadCancelled')));
        });
        request.send(archive);
      });
      router.push(`/app/${encodeURIComponent(workspace)}/agents/${imported.agentId}?settings=agent&imported=hermes`);
      router.refresh();
    } catch (error) {
      setImportState({
        pending: false,
        error: error instanceof Error ? error.message : t('hermesArchiveImportFailed'),
      });
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ui-button-primary">
        <Plus className="size-4" />
        {t('newSandbox')}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[4vh]"
          onMouseDown={() => {
            if (!importState.pending) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('newSandbox')}
            className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('newSandbox')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('chooseASandboxSource')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={importState.pending}
                aria-label={t('close')}
                className="ui-button-ghost ui-icon-button shrink-0 disabled:cursor-wait disabled:opacity-60"
              >
                <X className="size-4" />
              </button>
            </div>

            <form
              action={isHermesImport ? undefined : createSandboxAction}
              onSubmit={isHermesImport ? submitHermesArchive : undefined}
              className="min-h-0 overflow-y-auto p-5"
            >
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="kind" value={mode} />

              <div className="grid gap-5 xl:grid-cols-[19rem_minmax(0,1fr)]">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <ModeButton
                      active={isDocker}
                      icon={Container}
                      title={t('dockerContainer')}
                      description={t('managedLinuxWorkspaceWithPersistentFilesAndPackageInstalls')}
                      onClick={() => {
                        if (!importState.pending) setMode('docker');
                      }}
                    />
                    <ModeButton
                      active={mode === 'connector'}
                      icon={Cable}
                      title={t('userConnector')}
                      description={t('aUserRunsOneNpxCommandAndConnectsALocalMachineOverWebsocket')}
                      onClick={() => {
                        if (!importState.pending) setMode('connector');
                      }}
                    />
                    <ModeButton
                      active={isHermesImport}
                      icon={Upload}
                      title={t('importHermesArchive')}
                      description={t('importHermesArchiveModeDescription')}
                      onClick={() => {
                        if (!importState.pending) setMode('hermes-import');
                      }}
                    />
                  </div>

                  <div className="rounded-md border border-border bg-muted/20 px-3 py-3">
                    <Field label={t('name')}>
                      <input
                        name="name"
                        placeholder={isHermesImport ? t('importedHermes') : isDocker ? t('researchContainer') : t('myLaptop')}
                        className={inputClass}
                      />
                    </Field>

                    {isDocker ? (
                      <Field label={t('network')} className="mt-3" hint={t('isolatedKeepsItOffTheAppdatabaseNetworkWhileAllowingInternetEgress')}>
                        <div className="relative">
                          <Network className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <NativeSelect name="network" defaultValue="isolated" className="ui-input ui-input-icon h-9 w-full">
                            <option value="isolated">{t('isolated')}</option>
                            <option value="none">{t('none')}</option>
                          </NativeSelect>
                        </div>
                      </Field>
                    ) : null}

                    {isHermesImport ? (
                      <>
                        <div className="mt-3">
                          <HermesImageSelector id="hermes-import-version" images={hermesImages} />
                        </div>
                        <Field
                          label={t('hermesArchive')}
                          className="mt-3"
                          hint={t('hermesArchiveHint', { max: hermesArchiveLimitLabel(hermesArchiveMaxUploadMiB) })}
                        >
                          <input
                            name="hermesArchive"
                            type="file"
                            accept=".zip,application/zip"
                            required={isHermesImport}
                            aria-label={t('hermesArchive')}
                            onChange={() => {
                              hermesImportId.current = null;
                            }}
                            className="ui-input h-9 w-full cursor-pointer px-2 text-xs file:mr-3 file:border-0 file:bg-transparent file:text-xs file:font-medium"
                          />
                        </Field>
                        <label className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-3 text-xs leading-5 text-foreground">
                          <input name="trustArchive" type="checkbox" required className="mt-0.5 size-3.5 shrink-0 accent-brand" />
                          <span>{t('trustHermesArchive')}</span>
                        </label>
                        <label className="mt-3 flex items-start gap-2 rounded-md border border-border bg-background px-3 py-3 text-xs leading-5 text-foreground">
                          <input name="allowSudo" type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-brand" />
                          <span>
                            {t('allowSudo')}
                            <span className="mt-0.5 block text-[11px] font-normal leading-4 text-muted-foreground">
                              {t('allowSudoHint')}
                            </span>
                          </span>
                        </label>
                        {importState.error ? (
                          <p className="mt-3 text-xs leading-5 text-red-700 dark:text-red-300" role="alert">{importState.error}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <Field label={t('environment')} className="mt-3" hint={t('environmentVariablesHint')}>
                          <textarea
                            name="env"
                            rows={5}
                            spellCheck={false}
                            placeholder={t('envPlaceholder')}
                            className="ui-input min-h-28 w-full resize-y font-mono text-xs leading-5"
                          />
                        </Field>

                        <div className="mt-4 rounded-md border border-border bg-background px-3 py-2">
                          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                            <Sparkles className="size-3.5 text-muted-foreground" />
                            {t('recommendedChoices')}
                          </div>
                          <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                            <li>{t('frontendJavascriptNodeOrTypescriptNode')}</li>
                            <li>{t('lightweightDebianBaseThenInstallOnlyWhatYouNeed')}</li>
                            <li>{t('everythingUniversalLargerButBroad')}</li>
                          </ul>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {isHermesImport ? (
                  <div className="space-y-4">
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-4 py-4">
                      <div className="flex items-start gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-amber-500/25 bg-background text-amber-700 dark:text-amber-300">
                          <ShieldCheck className="size-4" />
                        </span>
                        <div>
                          <h2 className="text-sm font-semibold text-foreground">{t('importHermesArchive')}</h2>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('importHermesArchiveDetails')}</p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-background px-4 py-3">
                      <h3 className="text-sm font-semibold text-foreground">{t('whatGetsImported')}</h3>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                        <li>{t('hermesArchiveConfig')}</li>
                        <li>{t('hermesArchiveData')}</li>
                        <li>{t('hermesArchiveManagedPaths')}</li>
                      </ul>
                    </div>
                  </div>
                ) : isDocker ? (
                  <div className="space-y-5">
            <div className="rounded-md border border-border bg-muted/15 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">{t('chooseADevContainerImage')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('officialImagesFromMcrmicrosoftcomdevcontainersYouCanInstallMorePackagesAfterTheSandboxStarts')}
                  </p>
                </div>
                <span className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {customSelected ? customImage || t('customImage') : selectedImage}
                </span>
              </div>
            </div>

            <ImageGroup
              title={t('mostUsedLanguageStacks')}
              description={t('recommendedFirstChoicesForAgentWorkspaces')}
              options={recommendedImages}
              selectedImage={selectedImage}
              onSelect={setSelectedImage}
            />

            <ImageGroup
              title={t('generalPurposeImages')}
              description={t('useTheseWhenYouWantASmallerBaseOrAWiderToolset')}
              options={generalImages}
              selectedImage={selectedImage}
              onSelect={setSelectedImage}
            />

            <label
              className={cx(
                'block rounded-md border px-3 py-3 transition-colors',
                customSelected ? 'border-brand bg-brand-soft' : 'border-border bg-background',
              )}
            >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                  name="imageChoice"
                  value="custom"
                  checked={customSelected}
                  onChange={() => setSelectedImage('custom')}
                />
                <span className="text-sm font-semibold text-foreground">{t('customImage1')}</span>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('useAnotherDockerImageWhenTheOfficialPresetsDoNotFit')}
              </span>
              <div className="relative mt-3">
                <Server className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  name="customImage"
                  value={customImage}
                  onChange={(event) => {
                    setCustomImage(event.target.value);
                    setSelectedImage('custom');
                  }}
                  placeholder={t('ghcrioorgimagetag')}
                  className="ui-input ui-input-icon h-9 w-full font-mono text-xs"
                />
              </div>
            </label>

                  </div>
                ) : (
                  <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/15 px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">{t('connectAUserMachine')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('toolplaneGeneratesAOnetimeTokenTheUserRunsOneCommandAndTheConnectorCallsBackToThisServer')}
              </p>
            </div>

            <div className="rounded-md border border-border bg-background px-4 py-3">
              <ol className="space-y-2 text-xs text-muted-foreground">
                <li>{t('1CreateTheConnectorSandbox')}</li>
                <li>{t('2CopyTheGeneratedNpxCommandFromTheDetailPage')}</li>
                <li>{t('3RunItOnTheUserMachineThatShouldBecomeTheSandbox')}</li>
              </ol>
            </div>

                  </div>
                )}
              </div>
              <CreateSandboxFooter mode={mode} hermesImport={importState} />
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
