import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { defaultTpSkillsSource, syncGithubSkillRegistry } from '@/lib/skills/registry';

export const runtime = 'nodejs';

type GithubPushPayload = {
  ref?: string;
  repository?: {
    full_name?: string;
  };
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function verifyGithubSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = signature.slice('sha256='.length);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function expectedGithubRef(ref: string): string {
  if (ref.startsWith('refs/')) return ref;
  return `refs/heads/${ref}`;
}

// GitHub webhook target for asharca/tp-skills. Configure a repository webhook:
//   Payload URL: https://<toolplane-host>/api/v1/skill-registries/tp-skills/webhook
//   Content type: application/json
//   Secret: TP_SKILLS_WEBHOOK_SECRET
//   Events: push
export async function POST(req: Request) {
  const secret = process.env.TP_SKILLS_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'tp-skills webhook is not configured' }, 503);

  const rawBody = await req.text();
  if (!verifyGithubSignature(rawBody, req.headers.get('x-hub-signature-256'), secret)) {
    return json({ error: 'invalid signature' }, 401);
  }

  const event = req.headers.get('x-github-event');
  if (event === 'ping') return json({ ok: true, event: 'ping' });
  if (event !== 'push') return json({ ok: true, ignored: true, event });

  let payload: GithubPushPayload;
  try {
    payload = JSON.parse(rawBody) as GithubPushPayload;
  } catch {
    return json({ error: 'invalid json payload' }, 400);
  }

  const source = defaultTpSkillsSource();
  const expectedRepo = `${source.owner}/${source.repo}`.toLowerCase();
  const actualRepo = payload.repository?.full_name?.toLowerCase();
  if (actualRepo !== expectedRepo) {
    return json({ ok: true, ignored: true, reason: 'repository mismatch' });
  }

  const targetRef = expectedGithubRef(source.ref);
  if (payload.ref !== targetRef) {
    return json({ ok: true, ignored: true, reason: 'ref mismatch', ref: payload.ref });
  }

  const result = await syncGithubSkillRegistry(db, source);
  return json({
    ok: true,
    found: result.found,
    created: result.created,
    updated: result.updated,
    failed: result.failed.length,
    commitSha: result.commitSha,
    failures: result.failed,
  });
}
