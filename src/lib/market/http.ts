import { MarketError } from '@/lib/market/skills';

export function marketErrorResponse(error: unknown): Response {
  if (!(error instanceof MarketError)) {
    return Response.json({ error: 'Market operation failed.' }, { status: 500 });
  }
  const status = error.code === 'not_authorized'
    ? 403
    : error.code === 'source_not_found'
      || error.code === 'release_not_found'
      || error.code === 'install_not_found'
      ? 404
      : 409;
  return Response.json({ error: error.message, code: error.code }, { status });
}
