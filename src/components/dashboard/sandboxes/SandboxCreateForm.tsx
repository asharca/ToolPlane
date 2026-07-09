'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useFormStatus } from 'react-dom';
import {
  Cable,
  Check,
  Container,
  FolderOpen,
  Globe2,
  Loader2,
  Network,
  Plus,
  Server,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createSandboxAction } from '@/lib/sandboxes/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_IMAGE_OPTIONS,
  type SandboxImageOption,
} from '@/lib/sandboxes/images';

type Mode = 'docker' | 'connector';

const inputClass = 'ui-input h-9 w-full';
const recommendedImages = SANDBOX_IMAGE_OPTIONS.filter((option) => option.category === 'recommended');
const generalImages = SANDBOX_IMAGE_OPTIONS.filter((option) => option.category === 'general');

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
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">{options.length} images</span>
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

function CreateSandboxFooter({ isDocker }: { isDocker: boolean }) {
  const t = useTranslations('console.sandboxes');
  const { pending } = useFormStatus();

  return (
    <div className="sticky bottom-0 -mx-5 mt-5 border-t border-border bg-card/95 px-5 py-4 backdrop-blur">
      {pending ? (
        <div className="mb-3 rounded-md border border-brand/25 bg-brand-soft px-3 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="size-4 animate-spin" />
            {isDocker ? t('creatingSandboxRuntime') : t('creatingConnectorSandbox')}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {isDocker
              ? t('creatingSandboxRuntimeDescription')
              : t('creatingConnectorSandboxDescription')}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
          </div>
        </div>
      ) : null}
      <div className="flex justify-end">
        <SubmitButton
          flash={false}
          pendingLabel={isDocker ? t('creatingContainer') : t('creatingConnector')}
          className="ui-button-primary h-9 w-full sm:w-auto"
        >
          <Plus className="size-4" />
          {isDocker ? t('createContainer') : t('createConnector')}
        </SubmitButton>
      </div>
    </div>
  );
}

export function SandboxCreateForm({
  workspace,
  connectorServerUrl,
  defaultRemoteRoot,
}: {
  workspace: string;
  connectorServerUrl: string;
  defaultRemoteRoot: string;
}) {
  const [mode, setMode] = useState<Mode>('docker');
  const [selectedImage, setSelectedImage] = useState(DEFAULT_SANDBOX_IMAGE);
  const [customImage, setCustomImage] = useState('');
  const [open, setOpen] = useState(false);
  const t = useTranslations('console.sandboxes');
  const isDocker = mode === 'docker';
  const customSelected = selectedImage === 'custom';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ui-button-primary">
        <Plus className="size-4" />
        {t('newSandbox')}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[4vh]"
          onMouseDown={() => setOpen(false)}
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
                  {t('chooseADevContainerImageOrConnectAUserMachine')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('close')}
                className="ui-button-ghost ui-icon-button shrink-0"
              >
                <X className="size-4" />
              </button>
            </div>

            <form action={createSandboxAction} className="min-h-0 overflow-y-auto p-5">
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
                      onClick={() => setMode('docker')}
                    />
                    <ModeButton
                      active={!isDocker}
                      icon={Cable}
                      title={t('userConnector')}
                      description={t('aUserRunsOneNpxCommandAndConnectsALocalMachineOverWebsocket')}
                      onClick={() => setMode('connector')}
                    />
                  </div>

                  <div className="rounded-md border border-border bg-muted/20 px-3 py-3">
                    <Field label={t('name')}>
                      <input name="name" placeholder={isDocker ? t('researchContainer') : t('myLaptop')} className={inputClass} />
                    </Field>

                    {isDocker ? (
                      <Field label={t('network')} className="mt-3" hint={t('isolatedKeepsItOffTheAppdatabaseNetworkWhileAllowingInternetEgress')}>
                        <div className="relative">
                          <Network className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <select name="network" defaultValue="isolated" className="ui-input ui-input-icon h-9 w-full">
                            <option value="isolated">{t('isolated')}</option>
                            <option value="none">{t('none')}</option>
                          </select>
                        </div>
                      </Field>
                    ) : null}

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
                  </div>
                </div>

                {isDocker ? (
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

            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('platformUrl')} hint={t('theConnectorUsesThisToDiscoverTheWebsocketBroker')}>
                <div className="relative">
                  <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input name="connectorServerUrl" defaultValue={connectorServerUrl} className="ui-input ui-input-icon h-9 w-full" />
                </div>
              </Field>
              <Field label={t('localRoot')} hint={t('directoryOnTheUsersMachineExposedToTheAgent')}>
                <div className="relative">
                  <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input name="connectorRemoteRoot" defaultValue={defaultRemoteRoot} className="ui-input ui-input-icon h-9 w-full" />
                </div>
              </Field>
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
              <CreateSandboxFooter isDocker={isDocker} />
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
