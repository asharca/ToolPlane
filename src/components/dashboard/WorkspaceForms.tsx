'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  createWorkspaceAction, renameWorkspaceAction, deleteWorkspaceAction,
  removeWorkspaceMemberAction, leaveWorkspaceAction, revokeWorkspaceInvitationAction,
  transferWorkspaceOwnershipAction, acceptWorkspaceInvitationAction,
  type WorkspaceActionState,
} from '@/lib/workspace/management-actions';

type Action = (state: WorkspaceActionState, data: FormData) => Promise<WorkspaceActionState>;

export function WorkspaceActionForm({ action, children, label, danger = false }: {
  action: Action; children: ReactNode; label: string; danger?: boolean;
}) {
  const t = useTranslations('console.workspaces');
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3" aria-busy={pending} data-workspace-navigation={action === createWorkspaceAction ? '' : undefined} data-unsaved-changes={pending ? 'true' : undefined}>
      <fieldset disabled={pending} className="min-w-0 space-y-3 disabled:opacity-60">
        {children}
        <button type="submit" className={danger ? 'ui-button-secondary text-destructive' : 'ui-button-primary'}>
          {pending ? t('working') : label}
        </button>
      </fieldset>
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{state.success}</p> : null}
    </form>
  );
}

export function CreateWorkspaceForm({ intent = '', autoFocus = false }: { intent?: string; autoFocus?: boolean }) {
  const t = useTranslations('console.workspaces');
  const id = useId();
  return (
    <WorkspaceActionForm action={createWorkspaceAction} label={t('create')}>
      <input type="hidden" name="intent" value={intent} />
      <label htmlFor={id} className="block text-sm font-medium">{t('name')}</label>
      <input id={id} name="name" required maxLength={80} autoFocus={autoFocus} placeholder={t('namePlaceholder')} className="ui-input w-full" />
      <p className="text-xs leading-5 text-muted-foreground">{t('createHint')}</p>
    </WorkspaceActionForm>
  );
}

export function RenameWorkspaceForm({ slug, name, canManage }: { slug: string; name: string; canManage: boolean }) {
  const t = useTranslations('console.workspaces');
  const id = useId();
  return canManage ? (
    <WorkspaceActionForm action={renameWorkspaceAction} label={t('save')}>
      <input type="hidden" name="workspace" value={slug} />
      <label htmlFor={id} className="block text-sm font-medium">{t('name')}</label>
      <input id={id} name="name" defaultValue={name} required maxLength={80} className="ui-input w-full" />
      <p className="break-all text-xs text-muted-foreground">{t('stableAddress', { slug })}</p>
    </WorkspaceActionForm>
  ) : (
    <div className="space-y-2"><p className="font-medium">{name}</p><p className="text-sm text-muted-foreground">{t('ownerOnly')}</p></div>
  );
}

const memberActions = { remove: removeWorkspaceMemberAction, leave: leaveWorkspaceAction, revoke: revokeWorkspaceInvitationAction };

export function WorkspaceMemberAction({ slug, memberId, invitationId, kind }: {
  slug: string; memberId?: string; invitationId?: string; kind: keyof typeof memberActions;
}) {
  const t = useTranslations('console.workspaces');
  return (
    <details className="max-w-sm text-sm">
      <summary className="cursor-pointer rounded-md px-2 py-1 text-destructive focus-visible:outline-2">{t(kind)}</summary>
      <div className="mt-2 rounded-lg border border-border p-3">
        <WorkspaceActionForm action={memberActions[kind]} label={t('confirm')} danger>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="memberId" value={memberId ?? ''} />
          <input type="hidden" name="invitationId" value={invitationId ?? ''} />
          <p className="text-muted-foreground">{t(`${kind}Hint`)}</p>
        </WorkspaceActionForm>
      </div>
    </details>
  );
}

export function WorkspaceDeleteForm({ slug, name, status = 'active', impact }: {
  slug: string; name: string; status?: string; impact?: string;
}) {
  const t = useTranslations('console.workspaces');
  const [confirmation, setConfirmation] = useState('');
  const id = useId();
  const [state, action, pending] = useActionState(deleteWorkspaceAction, {});
  return (
    <details className="space-y-3 text-sm" open={status !== 'active' ? true : undefined}>
      <summary className="cursor-pointer rounded-md py-1 font-medium text-destructive focus-visible:outline-2">{t(status === 'active' ? 'delete' : 'retryDelete')}</summary>
      <form action={action} className="space-y-3" aria-busy={pending}>
        <p className="text-muted-foreground">{t('deleteHint')}</p>
        {impact ? <p className="text-muted-foreground">{impact}</p> : null}
        <input type="hidden" name="workspace" value={slug} />
        <label htmlFor={id} className="block break-words">{t('typeName', { name })}</label>
        <input id={id} name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required maxLength={80} autoComplete="off" disabled={pending} className="ui-input w-full" />
        <button type="submit" disabled={pending || confirmation !== name} className="ui-button-secondary text-destructive disabled:opacity-50">
          {pending ? t('deleting') : t('confirmDelete')}
        </button>
        {state.error ? <p role="alert" className="text-destructive">{state.error}</p> : null}
      </form>
    </details>
  );
}

export function WorkspaceTransferForm({ slug, name, members }: {
  slug: string; name: string; members: { userId: string; label: string }[];
}) {
  const t = useTranslations('console.workspaces');
  const id = useId();
  return (
    <details className="space-y-3 text-sm">
      <summary className="cursor-pointer rounded-md py-1 font-medium focus-visible:outline-2">{t('transfer')}</summary>
      <WorkspaceActionForm action={transferWorkspaceOwnershipAction} label={t('confirmTransfer')} danger>
        <p className="text-muted-foreground">{t('transferHint')}</p>
        <input type="hidden" name="workspace" value={slug} />
        <label htmlFor={`${id}-member`} className="block">{t('newOwner')}</label>
        <select id={`${id}-member`} name="memberId" required defaultValue="" className="ui-input w-full">
          <option value="" disabled>{t('selectMember')}</option>
          {members.map((member) => <option key={member.userId} value={member.userId}>{member.label}</option>)}
        </select>
        <label htmlFor={`${id}-name`} className="block break-words">{t('typeName', { name })}</label>
        <input id={`${id}-name`} name="confirmation" required maxLength={80} autoComplete="off" className="ui-input w-full" />
      </WorkspaceActionForm>
    </details>
  );
}

export function AcceptWorkspaceInvitationForm({ token }: { token: string }) {
  const t = useTranslations('console.workspaces');
  return <WorkspaceActionForm action={acceptWorkspaceInvitationAction} label={t('acceptInvitation')}><input type="hidden" name="token" value={token} /></WorkspaceActionForm>;
}
