'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export async function deployServerAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const serverId = String(formData.get('serverId') ?? '');
  if (!slug || !serverId) return;

  const user = await getCurrentUser();
  if (!user) return;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return;

  await db.deployment.upsert({
    where: { workspaceId_serverId: { workspaceId: ws.id, serverId } },
    update: {},
    create: { workspaceId: ws.id, serverId, status: 'running' },
  });

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/new`);
}

export async function removeDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;

  const user = await getCurrentUser();
  if (!user) return;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return;

  await db.deployment.deleteMany({ where: { id: deploymentId, workspaceId: ws.id } });
  revalidatePath(`/app/${slug}/mcp`);
}
