import { agentPublicApiOpenApi } from '@/lib/agents/public-api/openapi';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(agentPublicApiOpenApi, {
    headers: {
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}
