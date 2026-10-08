import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { SettingsModal } from './SettingsModal';

export async function WorkspaceSettingsDialog({ slug, children }: { slug: string; children: ReactNode }) {
  const t = await getTranslations('console.workspaces');
  return <SettingsModal title={t('settings')} fallbackHref={`/app/${encodeURIComponent(slug)}/chat`}>{children}</SettingsModal>;
}
