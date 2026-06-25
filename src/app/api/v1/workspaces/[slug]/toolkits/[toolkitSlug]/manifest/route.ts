import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
import { logRequest } from '@/lib/observability/log';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';

// Export a single toolkit manifest: only the MCP servers and skills the user
// assembled into this toolkit, as one JSON document an agent config consumes.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; toolkitSlug: string }> },
) {
  const start = Date.now();
  const { slug, toolkitSlug } = await params;

  const user = await resolveRequestUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ws = await db.workspace.findFirst({
    where: {
      slug,
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    select: { id: true, slug: true, name: true },
  });
  if (!ws) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const toolkit = await db.toolkit.findFirst({
    where: { workspaceId: ws.id, slug: toolkitSlug },
    include: {
      servers: {
        include: {
          deployment: {
            include: { server: { select: { name: true, slug: true } } },
          },
        },
      },
      skills: {
        include: {
          installedSkill: {
            include: { skill: { select: { name: true, slug: true } } },
          },
        },
      },
    },
  });
  if (!toolkit) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const manifest = {
    toolkit: { name: toolkit.name, slug: toolkit.slug, visibility: toolkit.visibility },
    workspace: { slug: ws.slug, name: ws.name },
    generatedAt: new Date().toISOString(),
    servers: toolkit.servers.map((s) => ({
      name: deploymentLabel(s.deployment).name,
      slug: s.deployment.server?.slug ?? s.deployment.sourceRef ?? s.deployment.id,
      status: liveStatus(s.deployment.id) ?? s.deployment.status,
      endpoint: `/api/v1/mcp/${s.deployment.id}/rpc`,
    })),
    skills: toolkit.skills.map((s) => ({
      name: skillLabel(s.installedSkill).name,
      slug: skillLabel(s.installedSkill).slug,
      download: `/api/v1/skills/${s.installedSkill.id}/download`,
    })),
  };

  await logRequest({
    workspaceId: ws.id,
    method: 'GET',
    path: `/workspaces/${slug}/toolkits/${toolkitSlug}/manifest`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${toolkitSlug}.toolkit.json"`,
    },
  });
}
