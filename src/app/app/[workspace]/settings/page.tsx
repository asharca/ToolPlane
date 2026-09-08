import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getWorkspaceForUser, getWorkspaceMembers } from '@/lib/workspace/queries';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { WorkspaceModelSettings } from '@/components/dashboard/models/WorkspaceModelSettings';
import { DashboardPanel } from '@/components/dashboard/DashboardUI';
import { RenameWorkspaceForm, WorkspaceDeleteForm, WorkspaceMemberAction, WorkspaceTransferForm } from '@/components/dashboard/WorkspaceForms';
import { listProviders } from '@/lib/agents/queries';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [t, management] = await Promise.all([getTranslations('console.settings'), getTranslations('console.workspaces')]);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app?view=workspaces&notice=unavailable');
  const isOwner = ws.ownerId === user.id;
  const [providers, members, impact, running] = await Promise.all([
    listProviders(ws.id), getWorkspaceMembers(ws.id),
    isOwner ? db.workspace.findUnique({ where: { id: ws.id }, select: { _count: { select: { deployments: true, agents: true, chatThreads: true, workSessions: true, installedSkills: true, toolkits: true, knowledgeBases: true } } } }) : null,
    isOwner ? db.workSession.count({ where: { workspaceId: ws.id, status: { in: ['queued', 'running', 'waiting_approval', 'waiting_user', 'cancelling'] } } }) : 0,
  ]);
  const modelSelection = (providerId: string | null, model: string | null) => (
    providerId && model && providers.some((provider) => provider.id === providerId && provider.models.includes(model)) ? { providerId, model } : null
  );
  return (
    <SettingsModal title={management('settings')} fallbackHref={`/app/${slug}/chat`}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <SettingsTabs slug={slug} />
        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-5 sm:p-6 lg:p-8">
          <DashboardPanel title={t('general')} description={management('sharedHint')}><RenameWorkspaceForm slug={slug} name={ws.name} canManage={isOwner} /></DashboardPanel>
          <DashboardPanel title={t('modelPreferences')} description={t('modelPreferencesDesc')}>
            {isOwner ? <WorkspaceModelSettings slug={slug} providers={providers.map((provider) => ({
              id: provider.id, name: provider.name, models: provider.models,
              modelRecords: (provider.modelRecords ?? []).map((model) => ({ modelId: model.modelId, primaryType: model.primaryType, capabilities: model.capabilities, inputModalities: model.inputModalities })),
            }))} defaultModel={modelSelection(ws.defaultModelProviderId, ws.defaultModel)} titleModel={modelSelection(ws.titleModelProviderId, ws.titleModel)} /> : <p className="text-sm text-muted-foreground">{management('ownerOnly')}</p>}
          </DashboardPanel>
          {isOwner ? (
            <DashboardPanel title={t('dangerZone')} tone="danger">
              <div className="space-y-5">
                {members.some((member) => member.userId !== user.id) ? <WorkspaceTransferForm slug={slug} name={ws.name} members={members.filter((member) => member.userId !== user.id).map((member) => ({ userId: member.userId, label: member.user.name ? `${member.user.name} (${member.user.email})` : member.user.email }))} /> : <p className="text-sm text-muted-foreground">{management('transferEmpty')}</p>}
                <WorkspaceDeleteForm slug={slug} name={ws.name} impact={management('deleteImpact', { members: members.length, resources: impact ? Object.values(impact._count).reduce((sum, count) => sum + count, 0) : 0, running })} />
              </div>
            </DashboardPanel>
          ) : <DashboardPanel title={management('leave')}><WorkspaceMemberAction slug={slug} kind="leave" /></DashboardPanel>}
        </div>
      </div>
    </SettingsModal>
  );
}
