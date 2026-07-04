import { db } from '@/lib/db';
import { buildSkillMarkdown } from '@/lib/skills/artifact';

// Public endpoint: GET /api/v1/skills/<slug>/skill.md
// Serves the catalog SKILL.md. Imported bundles keep the exact SKILL.md content;
// metadata-only skills get a generated starter artifact. No auth required —
// public directory content.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ installId: string }> },
) {
  const { installId: slug } = await params;
  const skill = await db.skill.findUnique({ where: { slug } });

  if (!skill) {
    return new Response('# Not found\n', { status: 404, headers: { 'content-type': 'text/markdown' } });
  }

  if (skill.content?.trim()) {
    return new Response(skill.content, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${slug}.SKILL.md"`,
      },
    });
  }

  if (skill.githubSource && !skill.githubSource.startsWith('https://github.com/')) {
    const parts = skill.githubSource.split('/');
    const [owner, repo, ...pathParts] = parts;
    const skillPath = pathParts.length > 0 ? `${pathParts.join('/')}/SKILL.md` : 'SKILL.md';
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${skillPath}`;
    return Response.redirect(rawUrl, 302);
  }

  const markdown = buildSkillMarkdown(skill);
  return new Response(markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}.SKILL.md"`,
    },
  });
}
