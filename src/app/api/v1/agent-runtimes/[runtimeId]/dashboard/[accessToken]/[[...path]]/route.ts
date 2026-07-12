import {
  ensureHermesDashboardBroker,
  hermesDashboardBrokerPublicUrl,
} from '@/lib/agents/hermes/dashboard-broker';
import {
  createHermesDashboardBrokerAccessToken,
  verifyHermesDashboardAccessToken,
} from '@/lib/agents/hermes/token';

export const runtime = 'nodejs';

type RouteParams = Promise<{
  runtimeId: string;
  accessToken: string;
  path?: string[];
}>;

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

function dashboardParentOrigin(req: Request): string {
  const requestUrl = new URL(req.url);
  const host = firstHeaderValue(req.headers.get('x-forwarded-host'))
    ?? firstHeaderValue(req.headers.get('host'))
    ?? requestUrl.host;
  const forwardedProto = firstHeaderValue(req.headers.get('x-forwarded-proto'))?.toLowerCase();
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? `${forwardedProto}:`
    : requestUrl.protocol;
  return new URL(`${protocol}//${host}`).origin;
}

async function redirectToDashboardBroker(req: Request, params: RouteParams): Promise<Response> {
  const { runtimeId, accessToken, path = [] } = await params;
  if (!verifyHermesDashboardAccessToken(runtimeId, accessToken)) {
    return errorResponse('Dashboard access is invalid or expired.', 401);
  }

  try {
    const broker = await ensureHermesDashboardBroker();
    const parentOrigin = dashboardParentOrigin(req);
    const publicRequestUrl = new URL(req.url);
    const parentUrl = new URL(parentOrigin);
    publicRequestUrl.protocol = parentUrl.protocol;
    publicRequestUrl.hostname = parentUrl.hostname;
    publicRequestUrl.port = parentUrl.port;
    const brokerToken = createHermesDashboardBrokerAccessToken(runtimeId, parentOrigin);
    const location = hermesDashboardBrokerPublicUrl(
      publicRequestUrl.toString(),
      runtimeId,
      brokerToken,
      path,
      broker.port,
    );
    return new Response(null, {
      status: 307,
      headers: {
        location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Hermes dashboard broker is unavailable.',
      503,
    );
  }
}

export async function GET(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}

export async function HEAD(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}

export async function POST(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}

export async function PUT(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}

export async function PATCH(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}

export async function DELETE(req: Request, { params }: { params: RouteParams }) {
  return redirectToDashboardBroker(req, params);
}
