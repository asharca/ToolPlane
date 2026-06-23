import { verifyApiToken } from '@/lib/auth/tokens';
import { getHubServers } from '@/lib/hub/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await verifyApiToken(request.headers.get('authorization'));
  if (!user) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  const servers = await getHubServers(user.id);
  return Response.json({
    user: { id: user.id, email: user.email },
    count: servers.length,
    servers: servers.map((s) => ({
      slug: s.slug,
      name: s.name,
      author: s.author,
      description: s.description,
      stars: s.stars,
    })),
  });
}
