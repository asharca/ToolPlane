'use client';
import { Button as BeuiButton, Input as BeuiInput } from '@/components/ui/Controls';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NativeSelect } from '@/components/ui/NativeSelect';

export function SshSandboxCreate({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('console.sandboxes'); const router = useRouter();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
  async function show() {
    setOpen(true); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/sandboxes/ssh`, { cache: 'no-store' });
      if (!response.ok) throw new Error(); setTargets((await response.json()).targets);
    } catch { setError(t('sshOperationFailed')); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/sandboxes/ssh`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: data.get('name'), targetId: data.get('targetId'), acknowledgeHostAccess: data.get('ack') === 'on' }) });
      const result = await response.json();
      if (!response.ok || !result.id) throw new Error();
      router.push(result.consolePath ?? `${window.location.pathname}/${encodeURIComponent(result.id)}`); router.refresh();
    } catch { setError(t('sshOperationFailed')); setBusy(false); }
  }
  return <div className="space-y-3">
    <BeuiButton nativeButton unstyled type="button" className="ui-button-secondary h-9 text-sm" onClick={() => open ? setOpen(false) : void show()} aria-expanded={open}>{t('sshCreate')}</BeuiButton>
    {open ? <form onSubmit={create} className="w-full max-w-lg space-y-3 rounded-md border border-border bg-card p-4">
      <p className="text-sm font-semibold">{t('sshCreate')}</p><p className="text-xs leading-5 text-muted-foreground">{t('sshTargetHint')}</p>
      <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
        <label className="block space-y-1 text-xs">{t('sandboxName')}<BeuiInput name="name" required maxLength={80} className="ui-input h-9 w-full" /></label>
        <label className="block space-y-1 text-xs">{t('sshApprovedTarget')}<NativeSelect name="targetId" required className="h-9 w-full" defaultValue=""><option value="" disabled>{t('sshSelectTarget')}</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</NativeSelect></label>
        {!targets.length && !busy ? <p className="text-xs text-muted-foreground">{t('sshNoTargets')}</p> : null}
        <label className="flex items-start gap-2 text-xs leading-5"><BeuiInput type="checkbox" name="ack" required className="mt-1" /><span>{t('sshHostAccessWarning')}</span></label>
        <BeuiButton nativeButton unstyled type="submit" disabled={!targets.length} className="ui-button-primary h-9 text-sm">{t('sshCreate')}</BeuiButton>
      </fieldset>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </form> : null}
  </div>;
}
