'use client';

import { useActionState, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
import { FormCheckbox } from '@/components/ui/FormCheckbox';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { piCatalogAction } from '@/lib/market/pi-catalog-actions';
import type { PiCatalogActionState } from '@/lib/market/pi-catalog-actions';

export function PiCatalogActionForm({ workspace, operation, children, label, values = {}, capture = false }: {
  workspace: string; operation: string; children?: ReactNode; label: string;
  values?: Record<string, string>; capture?: boolean;
}) {
  const t = useTranslations('console.market.piCatalog');
  const resetAllowed = useRef(false);
  const [state, action, pending] = useActionState<PiCatalogActionState, FormData>(async (previous, data) => {
    const result = await piCatalogAction(previous, data);
    resetAllowed.current = result.ok === true;
    return result;
  }, {});
  const errorKey = state.error && t.has(`errors.${state.error}`) ? `errors.${state.error}` : 'errors.action_failed';
  return <form action={action} onReset={(event) => { if (!resetAllowed.current) event.preventDefault(); }} className="space-y-3">
    <input type="hidden" name="workspace" value={workspace} />
    <input type="hidden" name="operation" value={operation} />
    {Object.entries(values).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <fieldset disabled={pending} className="min-w-0 space-y-3">
      {children}
      <SubmitButton pendingLabel={t(capture ? 'capturing' : 'working')} flash={false} variant="secondary" size="sm">{label}</SubmitButton>
    </fieldset>
    {state.error ? <p role="alert" className="text-sm text-destructive">{t(errorKey)}</p> : null}
    {state.ok ? <div role="status" className="space-y-2 text-sm text-muted-foreground">
      <p>{t(operation === 'install-official' ? 'officialInstalled' : capture ? 'submitted' : operation === 'check' ? 'checked' : 'saved')}</p>
      {state.installId ? <ButtonLink variant="ghost" size="sm" href={`/app/${encodeURIComponent(workspace)}/market/installed#install-${encodeURIComponent(state.installId)}`}>{t('installed')}</ButtonLink> : null}
      {state.listingId ? <ButtonLink variant="ghost" size="sm" href={`/app/${encodeURIComponent(workspace)}/toolkits/pi-packages#package-${encodeURIComponent(state.listingId)}`}>{t('workspacePackages')}</ButtonLink> : null}
    </div> : null}
  </form>;
}

export function PiOfficialInstallForm({ workspace, entry }: {
  workspace: string; entry: { name: string; version: string | null };
}) {
  const t = useTranslations('console.market.piCatalog');
  return <PiCatalogActionForm workspace={workspace} operation="install-official" label={t('installOfficial')} values={{ name: entry.name }} capture>
    <Input label={t('preciseVersion')} name="version" defaultValue={entry.version ?? ''} maxLength={240} />
    <p className="text-xs leading-5 text-muted-foreground">{t('officialInstallHelp')}</p>
    <p className="text-xs leading-5 text-muted-foreground">{t('executionWarning')}</p>
  </PiCatalogActionForm>;
}

export function PiCatalogImportForm({ workspace, sourceId, entry, categories, canManage }: {
  workspace: string; sourceId?: string; entry: { name: string; source: string; description: string };
  categories: Array<{ id: string; name: string }>; canManage: boolean;
}) {
  const t = useTranslations('console.market.piCatalog');
  if (!canManage) return <p className="text-xs text-muted-foreground">{t('managerRequired')}</p>;
  return <details className="min-w-0">
    <summary className="cursor-pointer text-sm font-medium text-foreground">{t('reviewImport')}</summary>
    <div className="mt-3">
      <PiCatalogActionForm workspace={workspace} operation="import" label={t('captureImport')} values={{ sourceId: sourceId ?? '' }} capture>
        <p className="text-sm text-muted-foreground">{t('importHelp')}</p>
        <Input label={t('packageSource')} name="source" defaultValue={entry.source} required maxLength={2048} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('name')} name="name" defaultValue={entry.name.slice(0, 240)} required maxLength={240} />
          <Input label={t('slug')} name="slug" defaultValue={entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)} required maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
        </div>
        <Input label={t('summary')} name="summary" defaultValue={entry.description.slice(0, 4000)} maxLength={4000} />
        <FormSelect label={t('category')} name="categoryIds" required options={[{ value: '', label: t('chooseCategory'), disabled: true }, ...categories.map((category) => ({ value: category.id, label: category.name }))]} />
        <p className="text-xs leading-5 text-muted-foreground">{t('executionWarning')}</p>
      </PiCatalogActionForm>
    </div>
  </details>;
}

export function PiSourceEditor({ workspace, source }: {
  workspace: string; source?: { id: string; name: string; kind: string; url: string; hasCredentials: boolean };
}) {
  const t = useTranslations('console.market.piCatalog');
  const [auth, setAuth] = useState('keep');
  return <div className="space-y-4">
    <PiCatalogActionForm workspace={workspace} operation={source ? 'update-source' : 'create-source'} label={t(source ? 'saveSource' : 'addSource')} values={{ sourceId: source?.id ?? '' }}>
      <Input label={t('name')} name="name" defaultValue={source?.name ?? ''} required maxLength={100} />
      {source ? <p className="text-xs text-muted-foreground">{t(`kind.${source.kind}`)}</p> : <FormSelect name="kind" label={t('sourceKind')} options={['catalog', 'npm', 'git'].map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))} />}
      <Input label={t('sourceUrl')} name="url" type="url" defaultValue={source?.url ?? ''} required maxLength={2048} placeholder="https://" />
      <p className="text-xs text-muted-foreground">{t('sourceHelp')}</p>
      <FormSelect name="auth" label={t('authentication')} value={auth} onValueChange={setAuth} options={[
        { value: 'keep', label: t(source?.hasCredentials ? 'keepCredentials' : 'noCredentials') },
        { value: 'bearer', label: t('bearer') }, { value: 'basic', label: t('basic') },
        ...(source?.hasCredentials ? [{ value: 'clear', label: t('clearCredentials') }] : []),
      ]} />
      {auth === 'bearer' ? <Input label={t('token')} type="password" name="token" autoComplete="new-password" required maxLength={4096} /> : null}
      {auth === 'basic' ? <><Input label={t('username')} name="username" autoComplete="off" required maxLength={240} /><Input label={t('password')} type="password" name="password" autoComplete="new-password" required maxLength={4096} /></> : null}
      <p className="text-xs text-muted-foreground">{t('credentialsHelp')}</p>
    </PiCatalogActionForm>
    {source ? <PiCatalogActionForm workspace={workspace} operation="delete-source" label={t('deleteSource')} values={{ sourceId: source.id }}>
      <FormCheckbox name="confirm" required label={t('deleteConfirm')} />
    </PiCatalogActionForm> : null}
  </div>;
}

export function PiRegistryPublishForm({ workspace, sources, releases }: {
  workspace: string; sources: Array<{ id: string; name: string }>;
  releases: Array<{ id: string; label: string }>;
}) {
  const t = useTranslations('console.market.piCatalog');
  if (!sources.length || !releases.length) return <p className="text-sm text-muted-foreground">{t('registryPrerequisites')}</p>;
  return <PiCatalogActionForm workspace={workspace} operation="registry-publish" label={t('publishRegistry')}>
    <FormSelect name="sourceId" label={t('registry')} options={sources.map((source) => ({ value: source.id, label: source.name }))} />
    <FormSelect name="releaseId" label={t('approvedRelease')} options={releases.map((release) => ({ value: release.id, label: release.label }))} />
    <Input label={t('registryTag')} name="tag" defaultValue="latest" maxLength={64} />
    <p className="text-sm text-muted-foreground">{t('registryHelp')}</p>
    <FormCheckbox name="confirm" required label={t('registryConfirm')} />
  </PiCatalogActionForm>;
}
