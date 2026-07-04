import { createHash } from 'node:crypto';
import { verifyApiToken } from '@/lib/auth/tokens';
import { db } from '@/lib/db';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import { logRequest } from '@/lib/observability/log';

export const runtime = 'nodejs';

// The plugin's SessionStart sync hook GETs this each session to refresh the
// toolkit's skills on disk. One SKILL.md per non-draft skill. version is a
// content hash so a future client can skip rewrites when unchanged.
function safeSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length >= 2 ? s : '';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function GET(req: Request) {
  const start = Date.now();
  const url = new URL(req.url);
  const workspaceSlug = url.searchParams.get('workspace') ?? '';
  const toolkitSlug = url.searchParams.get('toolkit') ?? '';

  const user = await verifyApiToken(req.headers.get('authorization'));
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!workspaceSlug || !toolkitSlug) {
    return json({ error: 'workspace and toolkit are required' }, 400);
  }

  // Workspace-scoped: only the owner or a member can read the toolkit's skills.
  const toolkit = await db.toolkit.findFirst({
    where: {
      slug: toolkitSlug,
      workspace: {
        slug: workspaceSlug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: {
      workspaceId: true,
      skills: {
        select: {
          installedSkill: {
            select: {
              skillId: true,
              name: true,
              slug: true,
              description: true,
              content: true,
              files: true,
              source: true,
              status: true,
              userInvocable: true,
              agentInvocable: true,
              effort: true,
              skill: {
                select: { slug: true, name: true, description: true, author: true, content: true, files: true },
              },
            },
          },
        },
      },
    },
  });
  if (!toolkit) return json({ error: 'toolkit not found' }, 404);

  const seen = new Set<string>();
  const skills: {
    slug: string;
    version: string;
    content: string;
    files: { path: string; content: string }[];
  }[] = [];
  for (const ts of toolkit.skills) {
    const s = ts.installedSkill;
    if (s.status === 'draft') continue;
    const slug = safeSlug(skillLabel(s).slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const content = buildInstalledSkillMarkdown(s);
    const files = installedSkillExtraFiles(s);
    const version = createHash('sha256')
      .update(JSON.stringify({ content, files }))
      .digest('hex')
      .slice(0, 12);
    skills.push({ slug, version, content, files });
  }

  await logRequest({
    workspaceId: toolkit.workspaceId,
    method: 'GET',
    path: `/plugin/baseline?workspace=${workspaceSlug}&toolkit=${toolkitSlug}`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return json({ data: { skills } });
}
