'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { UserPlus } from 'lucide-react';
import {
  inviteWorkspaceMemberAction,
  type WorkspaceInviteState,
} from '@/lib/workspace/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { DashboardPanel } from '@/components/dashboard/DashboardUI';

export function WorkspaceInviteForm({
  workspaceSlug,
  canInvite,
}: {
  workspaceSlug: string;
  canInvite: boolean;
}) {
  const t = useTranslations('console.members');
  const [state, formAction] = useActionState<WorkspaceInviteState, FormData>(
    inviteWorkspaceMemberAction,
    {},
  );

  return (
    <DashboardPanel
      title={t('inviteMember')}
      description={canInvite ? t('inviteMemberDescription') : t('onlyWorkspaceOwnerCanInviteMembers')}
      className="border-primary/20"
    >
      {canInvite ? (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 space-y-1.5 text-sm font-medium text-foreground">
              {t('emailAddress')}
              <input
                name="email"
                type="email"
                required
                placeholder="teammate@example.com"
                className="ui-input h-9"
              />
            </label>
            <SubmitButton
              error={state.error}
              pendingLabel={t('inviting')}
              savedLabel={t('invited')}
              className="ui-button-primary h-9 justify-center"
            >
              <UserPlus className="size-4" />
              {t('invite')}
            </SubmitButton>
          </div>
          {state.error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {state.error}
            </p>
          ) : null}
          {state.message ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
              {state.message}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
          <UserPlus className="size-4 shrink-0" />
          <span>{t('askOwnerToInviteMembers')}</span>
        </div>
      )}
    </DashboardPanel>
  );
}
