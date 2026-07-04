import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import { logRequest } from '@/lib/observability/log';

// Serve a real, downloadable SKILL.md for an installed skill. Auth via the
// dashboard session or a Bearer API token; access is scoped to the caller's
// workspaces.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ installId: string }> },
) {
  const start = Date.now();
  const { installId } = await params;

  const user = await resolveRequestUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const install = await db.installedSkill.findFirst({
    where: {
      id: installId,
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    include: {
      skill: { select: { slug: true, name: true, description: true, author: true, content: true, files: true } },
      workspace: { select: { id: true } },
    },
  });
  if (!install) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const markdown = buildInstalledSkillMarkdown(install);
  const slug = skillLabel(install).slug;

  await logRequest({
    workspaceId: install.workspace.id,
    method: 'GET',
    path: `/skills/${slug}/download`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return new Response(markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}.SKILL.md"`,
    },
  });
}
