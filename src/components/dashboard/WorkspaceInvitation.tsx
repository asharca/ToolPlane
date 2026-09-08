'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { previewWorkspaceInvitationAction, switchInvitationAccountAction } from '@/lib/workspace/management-actions';
import { AcceptWorkspaceInvitationForm } from './WorkspaceForms';

type Preview = Awaited<ReturnType<typeof previewWorkspaceInvitationAction>>;

export function WorkspaceInvitation({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations('console.workspaces');
  const auth = useTranslations('auth');
  const [state, setState] = useState<{ token: string; preview: Preview } | null>(null);
  useEffect(() => {
    let active = true;
    const key = 'toolplane:workspace-invitation';
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('invite');
    let token = fragment ?? '';
    try {
      if (fragment && /^[a-f0-9]{64}$/.test(fragment)) sessionStorage.setItem(key, fragment);
      else token = sessionStorage.getItem(key) ?? '';
    } catch { /* The original invitation can be reopened after login. */ }
    if (fragment) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    const load = async () => {
      const preview = signedIn ? await previewWorkspaceInvitationAction(token).catch(() => null) : null;
      if (active) setState({ token, preview });
    };
    void load();
    return () => { active = false; };
  }, [signedIn]);
  const next = encodeURIComponent('/app?view=invitation');
  return (
    <div className="space-y-4">
      {!state ? <p role="status">{t('loadingInvitation')}</p> : !signedIn ? <><p className="text-sm text-muted-foreground">{t('signInToJoin')}</p><div className="flex flex-wrap gap-2"><Link href={`/app/login?next=${next}`} className="ui-button-primary">{auth('signIn')}</Link><Link href={`/app/signup?next=${next}`} className="ui-button-secondary">{auth('signUpLink')}</Link></div></> : !state.preview ? <p role="alert">{t('errors.invalidInvitation')}</p> : !state.preview.canJoin ? (
        <form action={switchInvitationAccountAction} className="space-y-4"><p>{t('invitationAccount', { email: state.preview.email })}</p><button type="submit" className="ui-button-primary">{t('switchAccount')}</button></form>
      ) : <><h2 className="break-words text-lg font-medium">{state.preview.name}</h2><p className="text-sm text-muted-foreground">{t('invitationAccount', { email: state.preview.email })}</p><AcceptWorkspaceInvitationForm token={state.token} /></>}
      <Link href="/app?view=workspaces" className="ui-button-ghost">{t('backToList')}</Link>
    </div>
  );
}
