import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listProviders, listAgents } from '@/lib/agents/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { db } from '@/lib/db';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { WorkspaceKnowledge } from '@/components/dashboard/knowledge/WorkspaceKnowledge';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [user, t] = await Promise.all([getCurrentUser(), getTranslations('console.knowledge')]);
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const [bases, providers, sandboxes, agents] = await Promise.all([
    db.knowledgeBase.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: 'desc' },
      include: { provider: { select: { name: true } }, documents: { orderBy: { updatedAt: 'desc' } }, agentLinks: { select: { agentId: true } } },
    }),
    listProviders(workspace.id),
    listSandboxes(workspace.id),
    listAgents(workspace.id),
  ]);
  return (
    <>
      <DashboardHeader title={t('title')} />
      <WorkspaceKnowledge
        slug={slug}
        initialBases={bases.map((base) => ({
          id: base.id,
          name: base.name,
          embeddingModel: base.embeddingModel,
          chunkSize: base.chunkSize,
          chunkOverlap: base.chunkOverlap,
          topK: base.topK,
          threshold: base.threshold,
          providerId: base.providerId,
          providerName: base.provider?.name ?? null,
          agentIds: base.agentLinks.map((link) => link.agentId),
          documents: base.documents.map((document) => ({ id: document.id, filename: document.filename, status: document.status, error: document.error })),
        }))}
        providers={providers.map((provider) => ({ id: provider.id, name: provider.name, models: provider.models }))}
        sandboxes={sandboxes.map((sandbox) => ({ id: sandbox.id, name: sandbox.name, running: sandbox.deployment.status === 'running' }))}
        agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
      />
    </>
  );
}
