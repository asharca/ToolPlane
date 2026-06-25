import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
import { logRequest } from '@/lib/observability/log';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';

// Export a workspace "toolkit" manifest: every deployed MCP server (with its
// gateway endpoint) and installed skill, as a single JSON document an agent
// config can consume.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const start = Date.now();
  const { slug } = await params;

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
    include: {
      deployments: { include: { server: { select: { name: true, slug: true } } } },
      installedSkills: {
        include: { skill: { select: { name: true, slug: true } } },
      },
    },
  });
  if (!ws) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const manifest = {
    workspace: { slug: ws.slug, name: ws.name },
    generatedAt: new Date().toISOString(),
    servers: ws.deployments.map((d) => ({
      name: deploymentLabel(d).name,
      slug: d.server?.slug ?? d.sourceRef ?? d.id,
      status: liveStatus(d.id) ?? d.status,
      endpoint: `/api/v1/mcp/${d.id}/rpc`,
    })),
    skills: ws.installedSkills.map((i) => ({
      name: skillLabel(i).name,
      slug: skillLabel(i).slug,
      download: `/api/v1/skills/${i.id}/download`,
    })),
  };

  await logRequest({
    workspaceId: ws.id,
    method: 'GET',
    path: `/workspaces/${slug}/manifest`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${slug}.toolkit.json"`,
    },
  });
}
