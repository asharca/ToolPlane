import { ownership, runtimeIsReady } from '@/lib/runtime/ownership-state';
export const runtime = 'nodejs';
export function GET() {
  const ready = runtimeIsReady();
  return Response.json({ ready, runtime: ownership.status }, { status: ready ? 200 : 503,
    headers: { 'cache-control': 'no-store', ...(ready ? {} : { 'Retry-After': '5' }) } });
}
