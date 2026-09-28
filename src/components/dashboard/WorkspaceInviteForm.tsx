'use client';
import { Input } from '@/components/motion/input';
import { Button } from '@/components/motion/button';


import { useActionState, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inviteWorkspaceMemberAction } from '@/lib/workspace/management-actions';
import { DashboardPanel } from '@/components/dashboard/DashboardUI';

export function WorkspaceInviteForm({ workspaceSlug, canInvite }: { workspaceSlug: string; canInvite: boolean }) {
  const t = useTranslations('console.workspaces');
  const [state, action, pending] = useActionState(inviteWorkspaceMemberAction, {});
  const [copyStatus, setCopyStatus] = useState('');
  const id = useId();
  const link = state.invitePath ? new URL(state.invitePath, window.location.origin).href : '';
  return (
    <DashboardPanel title={t('invite')} description={t('inviteHint')}>
      {canInvite ? <form action={action} className="space-y-3" aria-busy={pending} onSubmit={() => setCopyStatus('')}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <label htmlFor={id} className="block text-sm font-medium">{t('email')}</label>
        <Input id={id} name="email" type="email" required maxLength={320} disabled={pending} placeholder="teammate@example.com" className="w-full" />
        <Button type="submit" disabled={pending} variant="primary" size="md">{pending ? t('working') : t('createInvitation')}</Button>
        {state.error ? <p className="text-sm text-destructive" role="alert">{state.error}</p> : null}
        {link ? <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs leading-5 text-muted-foreground" role="status">{t('invitationCreated')}</p>
          <label htmlFor={`${id}-link`} className="block text-xs font-medium">{t('invitationLink')}</label>
          <Input id={`${id}-link`} value={link} readOnly onFocus={(event) => event.target.select()} className="w-full" />
          <Button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopyStatus(t('copied')); }
            catch { setCopyStatus(t('copyFailed')); }
          }} variant="secondary" size="sm">{t('copyLink')}</Button>
          {copyStatus ? <p className="text-xs" role="status">{copyStatus}</p> : null}
        </div> : null}
      </form> : <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>}
    </DashboardPanel>
  );
}
