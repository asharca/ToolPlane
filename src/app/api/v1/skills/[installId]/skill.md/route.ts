import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { logRequest } from '@/lib/observability/log';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';

// Compatibility alias for installed-skill downloads. Like /download, this
// accepts either the dashboard session or a Bearer API token and scopes the
// install to a workspace owned by (or shared with) the caller.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ installId: string }> },
) {
  const start = Date.now();
  const { installId } = await params;

  const user = await resolveRequestUser(req);
  if (!user) {
    return Response.json({ error: 'unauthorized' }, {
      status: 401,
      headers: { 'cache-control': 'private, no-store' },
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
      skill: {
        select: {
          slug: true,
          name: true,
          description: true,
          author: true,
          content: true,
          files: true,
        },
      },
      workspace: { select: { id: true } },
    },
  });
  if (!install) {
    return Response.json({ error: 'not found' }, {
      status: 404,
      headers: { 'cache-control': 'private, no-store' },
    });
  }

  const markdown = buildInstalledSkillMarkdown(install);
  const slug = skillLabel(install).slug;

  await logRequest({
    workspaceId: install.workspace.id,
    method: 'GET',
    path: `/skills/${slug}/skill.md`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return new Response(markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}.SKILL.md"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
