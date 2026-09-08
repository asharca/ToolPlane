import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { DashboardPanel } from './DashboardUI';
import { WorkspaceInvitation } from './WorkspaceInvitation';

export async function WorkspaceInvitationPage({ signedIn }: { signedIn: boolean }) {
  const [messages, t] = await Promise.all([getMessages(), getTranslations('console.workspaces')]);
  return <NextIntlClientProvider messages={{ console: messages.console, auth: messages.auth }}><main className="mx-auto max-w-xl px-4 py-16"><DashboardPanel title={t('invitationTitle')} description={t('sharedHint')}><WorkspaceInvitation signedIn={signedIn} /></DashboardPanel></main></NextIntlClientProvider>;
}
