import 'server-only';
import { db } from '@/lib/db';

// Idempotent on (workspace, skill). Shared by the public one-click add action.
export async function upsertInstalledSkill(workspaceId: string, skillId: string) {
  return db.installedSkill.upsert({
    where: { workspaceId_skillId: { workspaceId, skillId } },
    update: {},
    create: { workspaceId, skillId },
  });
}
