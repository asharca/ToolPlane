import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { KeyRound, LockKeyhole, Settings, type LucideIcon } from 'lucide-react';
import { listApiTokens } from '@/lib/auth/tokens';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { TimeZoneSettings } from '@/components/timezone/TimeZoneSettings';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { ChangePasswordForm } from '@/components/auth/PasswordRecoveryForms';
import { DashboardPanel } from './DashboardUI';
import { TokenManager } from './TokenManager';
import type { WorkspaceAccountUser } from './WorkspaceAccountPage';

export type PersonalSettingsSection = 'preferences' | 'security' | 'tokens';

export async function PersonalSettingsContent({
  user,
  workspaceSlug,
  section = 'preferences',
  returnTo,
}: {
  user: WorkspaceAccountUser;
  workspaceSlug?: string;
  section?: PersonalSettingsSection;
  returnTo?: string;
}) {
  const [t, locale] = await Promise.all([
    getTranslations('console.settings'),
    getLocale(),
  ]);
  const workspacesT = await getTranslations('console.workspaces');
  const tokens = await listApiTokens(user.id);
  const timeZone = resolveUserTimeZone(user);
  const date = (value: Date | null) => value
    ? formatInTimeZone(value, timeZone, { dateStyle: 'medium' }, locale)
    : null;

  const tabs: Array<{ id: PersonalSettingsSection; label: string; icon: LucideIcon }> = [
    { id: 'preferences', label: t('preferences'), icon: Settings },
    { id: 'security', label: t('security'), icon: LockKeyhole },
    { id: 'tokens', label: t('tokens'), icon: KeyRound },
  ];
  const hrefFor = (nextSection: PersonalSettingsSection) => {
    const params = new URLSearchParams();
    if (returnTo) params.set('returnTo', returnTo);
    if (nextSection !== 'preferences') params.set('section', nextSection);
    const query = params.toString();
    return workspaceSlug
      ? `/app/${encodeURIComponent(workspaceSlug)}/settings/account${query ? `?${query}` : ''}`
      : '/app?view=account';
  };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 bg-shell/70 md:w-52">
        <nav aria-label={t('title')} className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible md:p-4">
          {tabs.map(({ id, label, icon: Icon }) => (
            <Link
              key={id}
              href={hrefFor(id)}
              aria-current={section === id ? 'page' : undefined}
              className={`flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${section === id ? 'bg-brand-soft font-medium text-foreground ring-1 ring-brand/10' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}`}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-5 sm:p-6 lg:p-8">
        <p className="text-sm text-muted-foreground">{workspacesT('accountHint')}</p>
        {section === 'preferences' ? <DashboardPanel title={t('preferences')}>
          <div className="space-y-5">
            <p className="break-all text-sm">{user.email}</p>
            <div className="flex flex-wrap items-center justify-between gap-3"><span>{t('language')}</span><LocaleSwitcher /></div>
            <div className="flex items-center justify-between gap-3"><span>{t('appearance')}</span><ThemeToggle /></div>
            <TimeZoneSettings timeZoneOverride={user.timeZoneOverride} />
          </div>
        </DashboardPanel> : null}
        {section === 'security' ? <DashboardPanel title={t('security')} description={t('passwordSettingsDesc')}><ChangePasswordForm /></DashboardPanel> : null}
        {section === 'tokens' ? <TokenManager tokens={tokens.map((token) => ({ id: token.id, name: token.name, prefix: token.prefix, createdAt: date(token.createdAt) ?? '', lastUsedAt: date(token.lastUsedAt) }))} /> : null}
      </div>
    </div>
  );
}
