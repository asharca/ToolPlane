'use client';

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
        <input id={id} name="email" type="email" required maxLength={320} disabled={pending} placeholder="teammate@example.com" className="ui-input w-full" />
        <button type="submit" disabled={pending} className="ui-button-primary">{pending ? t('working') : t('createInvitation')}</button>
        {state.error ? <p className="text-sm text-destructive" role="alert">{state.error}</p> : null}
        {link ? <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs leading-5 text-muted-foreground" role="status">{t('invitationCreated')}</p>
          <label htmlFor={`${id}-link`} className="block text-xs font-medium">{t('invitationLink')}</label>
          <input id={`${id}-link`} value={link} readOnly onFocus={(event) => event.target.select()} className="ui-input w-full text-xs" />
          <button type="button" className="ui-button-secondary ui-button-sm" onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopyStatus(t('copied')); }
            catch { setCopyStatus(t('copyFailed')); }
          }}>{t('copyLink')}</button>
          {copyStatus ? <p className="text-xs" role="status">{copyStatus}</p> : null}
        </div> : null}
      </form> : <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>}
    </DashboardPanel>
  );
}
