'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
import { FormCheckbox } from '@/components/ui/FormCheckbox';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { managePiPackageClientAction } from '@/lib/market/pi-client-actions';
import type { PiClientActionState } from '@/lib/market/pi-client-actions';
import type { PiPackageBindings } from '@/lib/pi-packages/installations';

export type PiClientRelease = {
  id: string; version: number; name: string; sourceVersion: string | null; checksum: string;
  requirements: Array<{ key: string; name: string; tools: string[] }>;
};
export type PiClientDeployment = { id: string; name: string; tools: string[] };

function PrivateConfig({ config }: { config: NonNullable<PiClientActionState['privateConfig']> }) {
  const t = useTranslations('console.market.piClients');
  const [revealed, setRevealed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return <p role="status">{t('configDismissed')}</p>;
  const filename = `toolplane-${config.installationId}.private.json`;
  const text = JSON.stringify(config, null, 2);
  const path = `"$HOME/.config/toolplane/pi-packages/${config.installationId}/config.json"`;
  const commands = `mkdir -p "$HOME/.config/toolplane/pi-packages/${config.installationId}"\ninstall -m 600 "./${filename}" ${path}\nnode ./pi-package-install.mjs install --config ${path}\n# ${t('localUpdate')}\nnode ./pi-package-install.mjs update --config ${path}\n# ${t('localUninstall')}\nnode ./pi-package-install.mjs uninstall --config ${path}`;
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <div role="status" className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-medium">{t('privateConfig')}</h3>
    <p className="text-sm text-muted-foreground">{t('oneTimeWarning')}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={download}>{t('downloadConfig')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setRevealed(!revealed)}>{t(revealed ? 'hideConfig' : 'revealConfig')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => { setRevealed(false); setDismissed(true); }}>{t('dismissConfig')}</Button>
    </div>
    {revealed ? <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs" aria-label={t('privateConfig')}>{text}</pre> : null}
    <a className="text-sm underline" href="/api/v1/pi-packages/installer" download="pi-package-install.mjs">{t('downloadInstaller')}</a>
    <p className="text-xs text-muted-foreground">{t('commandHelp')}</p>
    <pre className="overflow-x-auto text-xs">{commands}</pre>
  </div>;
}

export function PiClientInstallForm({ workspace, marketInstallId, release, deployments, defaults, existing, workspaceBindings = false }: {
  workspace: string; marketInstallId: string; release: PiClientRelease; deployments: PiClientDeployment[];
  defaults: PiPackageBindings; existing?: { id: string; client: string; bindings: PiPackageBindings };
  workspaceBindings?: boolean;
}) {
  const t = useTranslations('console.market.piClients');
  const [state, action, pending] = useActionState<PiClientActionState, FormData>(managePiPackageClientAction, {});
  const [client, setClient] = useState(existing?.client ?? 'pi');
  const [bindings, setBindings] = useState<PiPackageBindings>(() => Object.fromEntries(release.requirements.flatMap((requirement) => {
    const binding = (existing?.bindings ?? defaults)[requirement.key];
    const deployment = deployments.find((item) => item.id === binding?.deploymentId);
    return binding && deployment ? [[requirement.key, { deploymentId: binding.deploymentId, tools: binding.tools.filter((tool) => requirement.tools.includes(tool) && deployment.tools.includes(tool)) }]] : [];
  })));
  const valid = release.requirements.every(({ key, tools }) => bindings[key]?.deploymentId && (workspaceBindings ? bindings[key]?.tools.length === tools.length : bindings[key]?.tools.length));
  const errorKey = state.error && t.has(`errors.${state.error}`) ? `errors.${state.error}` : 'errors.pi_client_action_failed';
  if (state.privateConfig) return <PrivateConfig config={state.privateConfig} />;
  return <form action={action} className="space-y-4">
    <input type="hidden" name="workspace" value={workspace} />
    <input type="hidden" name="marketInstallId" value={marketInstallId} />
    <input type="hidden" name="operation" value={workspaceBindings ? 'workspace-bindings' : existing ? 'update' : 'create'} />
    <input type="hidden" name="installationId" value={existing?.id ?? ''} />
    <input type="hidden" name="releaseId" value={release.id} />
    <input type="hidden" name="bindings" value={JSON.stringify(bindings)} />
    <fieldset disabled={pending} className="min-w-0 space-y-3">
      {!existing && !workspaceBindings ? <>
        <Input name="label" label={t('deviceLabel')} required maxLength={100} autoComplete="off" />
        <FormSelect name="client" label={t('client')} value={client} onValueChange={setClient} options={['pi', 'claude-code', 'codex', 'opencode', 'hermes'].map((value) => ({ value, label: value }))} />
      </> : null}
      {workspaceBindings ? <p className="text-sm text-muted-foreground">{t('workspaceBindingsHelp')}</p> : <>
        <p className="text-sm text-muted-foreground">{t('globalScope')}</p>
        <p className="text-sm text-muted-foreground">{t(client === 'pi' ? 'piBehavior' : 'omittedBehavior')}</p>
      </>}
      <p className="text-sm">{t('targetRelease', { version: release.version, name: release.name, sourceVersion: release.sourceVersion ?? '—' })}</p>
      <code className="block break-all text-xs">{release.id} · {release.checksum}</code>
      <p className="text-sm text-muted-foreground">{t('bindingHelp')}</p>
      {release.requirements.map((requirement) => {
        const binding = bindings[requirement.key];
        const deployment = deployments.find((item) => item.id === binding?.deploymentId);
        return <fieldset key={requirement.key} className="space-y-2 rounded-lg border border-border p-3">
          <legend className="text-sm font-medium">{requirement.name} · {requirement.key}</legend>
          <FormSelect label={t('deployment')} value={binding?.deploymentId ?? ''} onValueChange={(deploymentId) => setBindings((current) => ({ ...current, [requirement.key]: { deploymentId, tools: [] } }))} options={[
            { value: '', label: t('chooseDeployment'), disabled: true },
            ...deployments.map((item) => ({ value: item.id, label: item.name, disabled: !requirement.tools.some((tool) => item.tools.includes(tool)) })),
          ]} />
          {requirement.tools.map((tool) => <FormCheckbox key={tool} label={tool} disabled={!deployment?.tools.includes(tool)} checked={binding?.tools.includes(tool) ?? false} onCheckedChange={(checked) => setBindings((current) => ({ ...current, [requirement.key]: { deploymentId: current[requirement.key]?.deploymentId ?? '', tools: checked ? [...(current[requirement.key]?.tools ?? []), tool] : (current[requirement.key]?.tools ?? []).filter((name) => name !== tool) } }))} />)}
        </fieldset>;
      })}
      {!valid ? <p className="text-sm text-destructive">{t(workspaceBindings ? 'workspaceBindingsRequired' : 'bindingsRequired')}</p> : null}
      {existing || workspaceBindings ? <FormCheckbox name="confirmExpandedPrivileges" value="yes" required label={t('permissionConfirmation')} /> : <FormCheckbox required label={t('createConfirmation')} />}
      <SubmitButton pendingLabel={t('working')} disabled={!valid} flash={false} variant="primary" size="sm">{t(workspaceBindings ? 'saveWorkspaceBindings' : existing ? 'applyUpdate' : 'create')}</SubmitButton>
    </fieldset>
    {state.error ? <p role="alert" className="text-sm text-destructive">{t(errorKey)}</p> : null}
    {state.ok ? <p role="status" className="text-sm">{t(workspaceBindings ? 'workspaceBindingsSaved' : 'updated')}</p> : null}
  </form>;
}

export function PiClientRevokeForm({ workspace, installationId }: { workspace: string; installationId: string }) {
  const t = useTranslations('console.market.piClients');
  const [state, action] = useActionState<PiClientActionState, FormData>(managePiPackageClientAction, {});
  return <form action={action} className="space-y-2">
    <input type="hidden" name="workspace" value={workspace} />
    <input type="hidden" name="operation" value="revoke" />
    <input type="hidden" name="installationId" value={installationId} />
    <FormCheckbox required label={t('revokeConfirmation')} />
    <SubmitButton pendingLabel={t('working')} flash={false} variant="secondary" size="sm">{t('revoke')}</SubmitButton>
    {state.error ? <p role="alert" className="text-sm text-destructive">{t('errors.pi_client_action_failed')}</p> : null}
    {state.ok ? <p role="status" className="text-sm">{t('revoked')}</p> : null}
  </form>;
}
