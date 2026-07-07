import { NextResponse } from 'next/server';
import { adminGate } from '@/lib/auth/admin-policy';
import { getCurrentUser } from '@/lib/auth/current-user';
import { applySystemUpdate, getLocalSystemUpdateStatus, getSystemUpdateStatus } from '@/lib/system/release-update';

export const runtime = 'nodejs';

async function requireApiAdmin() {
  const user = await getCurrentUser();
  const gate = adminGate(user);
  if (gate === 'login') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (gate === 'forbidden') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = await requireApiAdmin();
  if (denied) return denied;
  const url = new URL(request.url);
  if (url.searchParams.get('local') === '1') {
    return NextResponse.json(await getLocalSystemUpdateStatus());
  }
  return NextResponse.json(await getSystemUpdateStatus());
}

export async function POST() {
  const denied = await requireApiAdmin();
  if (denied) return denied;

  const result = await applySystemUpdate();
  const status = result.ok
    ? result.status === 'restarting'
      ? 202
      : 200
    : result.status === 'disabled'
      ? 400
      : result.status === 'unavailable'
        ? 503
        : 500;

  return NextResponse.json(result, {
    status,
  });
}
