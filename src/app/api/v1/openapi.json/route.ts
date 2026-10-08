import { agentPublicApiOpenApi } from '@/lib/agents/public-api/openapi';
import { a2aOpenApi } from '@/lib/a2a/openapi';

export const dynamic = 'force-static';

export function GET() {
  return Response.json({
    ...agentPublicApiOpenApi,
    tags: [...a2aOpenApi.tags, ...agentPublicApiOpenApi.tags],
    components: {
      ...agentPublicApiOpenApi.components,
      securitySchemes: { ...agentPublicApiOpenApi.components.securitySchemes, ...a2aOpenApi.securitySchemes },
      schemas: { ...agentPublicApiOpenApi.components.schemas, ...a2aOpenApi.schemas },
    },
    paths: { ...a2aOpenApi.paths, ...agentPublicApiOpenApi.paths },
  }, {
    headers: {
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}
