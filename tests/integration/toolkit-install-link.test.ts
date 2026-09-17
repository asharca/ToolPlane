// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken, hashToken, verifyApiTokenContext, verifyApiToken } from '@/lib/auth/tokens';
import { getOrCreateToolkitInstallLink, issueInstallToken, revokeInstallationForLink, INSTALL_TOKEN_GRACE_MS } from '@/lib/toolkits/install-link';
import { GET as installGET, POST as installPOST } from '@/app/install/[id]/route';
import { GET as uninstallGET } from '@/app/install/[id]/uninstall/route';
import { GET as installationsGET, POST as installationsPOST } from '@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/installations/route';
import { GET as baselineGET } from '@/app/api/v1/plugin/baseline/route';
import { POST as mcpPOST } from '@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route';
import * as audit from '@/lib/observability/audit';
const downstream = vi.hoisted(() => ({ rpc: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/process/mcp-client', () => ({ mcpRpc: downstream.rpc, listMcpTools: downstream.list }));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: () => 'running' }));
let userId: string, workspaceId: string, workspaceSlug: string, otherWorkspaceId: string, otherWorkspaceSlug: string, toolkitId: string, linkId: string;
const tkSlug = 'devtools';
beforeEach(async () => {
  vi.clearAllMocks(); const stamp = randomUUID();
  userId = (await db.user.create({ data: { email: `installation-${stamp}@test.dev`, passwordHash: 'x' } })).id;
  const ws = await db.workspace.create({ data: { name: 'Install', slug: `install-${stamp}`, ownerId: userId } });
  workspaceId = ws.id; workspaceSlug = ws.slug;
  const other = await db.workspace.create({ data: { name: 'Other', slug: `other-${stamp}`, ownerId: userId } });
  otherWorkspaceId = other.id; otherWorkspaceSlug = other.slug;
  toolkitId = (await db.toolkit.create({ data: { workspaceId, name: 'Kit', slug: tkSlug } })).id;
  await db.toolkit.create({ data: { workspaceId, name: 'Other Kit', slug: 'other' } });
  await db.toolkit.create({ data: { workspaceId: otherWorkspaceId, name: 'Other Workspace Kit', slug: tkSlug } });
  linkId = (await getOrCreateToolkitInstallLink(toolkitId, userId)).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.logEvent.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await db.auditEvent.deleteMany({ where: { actorId: userId } }); await db.user.deleteMany({ where: { id: userId } });
});
const ctx = () => ({ params: Promise.resolve({ slug: workspaceSlug, toolkitSlug: tkSlug }) });
const valid = (token: string) => verifyApiTokenContext(`Bearer ${token}`);
function management(body: unknown, token: string) { return new Request('http://localhost/api/v1/installations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); }
function tokenFromScript(script: string) {
  const m = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$(?:PLUGIN_DIR|BUNDLE_DIR)\/\.mcp\.json"/.exec(script);
  if (!m) throw new Error('MCP config missing'); const cfg = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  return String(Object.values<{ headers: { Authorization: string } }>(cfg.mcpServers)[0].headers.Authorization).replace('Bearer ', '');
}
describe('per-installation credentials', () => {
  it('GET previews and uninstall previews are side-effect free', async () => {
    const same = await getOrCreateToolkitInstallLink(toolkitId, userId); expect(same.id).toBe(linkId);
    for (const read of [installGET, uninstallGET]) {
      const response = await read(new Request(`http://localhost/install/${linkId}?client=codex`), { params: Promise.resolve({ id: linkId }) });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(await db.apiToken.count({ where: { userId } })).toBe(0);
    expect(await db.toolkitInstallation.count({ where: { userId } })).toBe(0);
  });
  it('POST creates a hashed scoped registration and a runnable client installer', async () => {
    const response = await installPOST(management({ client: 'codex', label: 'Laptop' }, 'unused'), { params: Promise.resolve({ id: linkId }) });
    expect(response.status).toBe(200); const body = await response.json(); const token = tokenFromScript(body.script);
    const row = await db.apiToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(row.toolkitId).toBe(toolkitId); expect(row.installationId).toBe(body.installationId);
    expect(JSON.stringify(row)).not.toContain(token); expect((await valid(token))?.token.installationId).toBe(body.installationId);
    expect(await verifyApiToken(`Bearer ${token}`)).toBeNull(); // User-only consumers cannot expand scope.
  });
  it('two devices of the same client remain independently usable and revocable', async () => {
    const a = (await issueInstallToken(linkId, 'codex', { label: 'A' }))!;
    const b = (await issueInstallToken(linkId, 'codex', { label: 'B' }))!;
    expect(a.installationId).not.toBe(b.installationId); expect(await valid(a.token)).not.toBeNull(); expect(await valid(b.token)).not.toBeNull();
    expect(await revokeInstallationForLink(linkId, a.installationId, `Bearer ${b.token}`, 'codex')).toBeNull();
    expect(await revokeInstallationForLink(linkId, a.installationId, `Bearer ${a.token}`, 'hermes')).toBeNull();
    await revokeInstallationForLink(linkId, a.installationId, `Bearer ${a.token}`, 'codex');
    expect(await valid(a.token)).toBeNull(); expect(await valid(b.token)).not.toBeNull();
    expect(await revokeInstallationForLink(linkId, a.installationId, `Bearer ${a.token}`, 'codex')).not.toBeNull();
  });
  it('rotation has bounded grace and cannot rotate another registration', async () => {
    const a = (await issueInstallToken(linkId, 'codex'))!; const b = (await issueInstallToken(linkId, 'codex'))!;
    expect(await issueInstallToken(linkId, 'codex', { installationId: b.installationId, authorization: `Bearer ${a.token}` })).toBeNull();
    const before = Date.now(); const rotated = (await issueInstallToken(linkId, 'codex', { installationId: a.installationId, authorization: `Bearer ${a.token}` }))!;
    expect(rotated.installationId).toBe(a.installationId); expect(rotated.token).not.toBe(a.token);
    const old = await db.apiToken.findUniqueOrThrow({ where: { tokenHash: hashToken(a.token) } });
    expect(old.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + INSTALL_TOKEN_GRACE_MS);
    expect(old.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + INSTALL_TOKEN_GRACE_MS);
    expect(await valid(a.token)).not.toBeNull(); expect(await valid(rotated.token)).not.toBeNull(); expect(await valid(b.token)).not.toBeNull();
  });
  it('audit failure rolls rotation back, leaving the existing credential usable', async () => {
    const a = (await issueInstallToken(linkId, 'codex'))!;
    vi.spyOn(audit, 'writeAudit').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(issueInstallToken(linkId, 'codex', { installationId: a.installationId, authorization: `Bearer ${a.token}` })).rejects.toThrow('audit');
    const rows = await db.apiToken.findMany({ where: { installationId: a.installationId } });
    expect(rows).toHaveLength(1); expect(rows[0].expiresAt).toBeNull(); expect(await valid(a.token)).not.toBeNull();
  });
  it('management lists metadata, revokes all installations, and invalidates rotated links', async () => {
    const a = (await issueInstallToken(linkId, 'codex'))!; const b = (await issueInstallToken(linkId, 'hermes'))!;
    const account = await createApiToken(userId, 'account');
    const listed = await installationsGET(new Request('http://localhost/installations', { headers: { authorization: `Bearer ${account.token}` } }), ctx());
    const text = await listed.text(); expect(text).toContain(a.installationId); expect(text).not.toContain(a.token); expect(text).not.toContain('tokenHash');
    expect((await installationsPOST(management({ operation: 'rotate-link' }, account.token), ctx())).status).toBe(200);
    expect((await installGET(new Request(`http://localhost/install/${linkId}`), { params: Promise.resolve({ id: linkId }) })).status).toBe(404);
    expect(await valid(a.token)).not.toBeNull();
    expect((await installationsPOST(management({ operation: 'revoke-all' }, account.token), ctx())).status).toBe(200);
    expect(await valid(a.token)).toBeNull(); expect(await valid(b.token)).toBeNull(); expect(await valid(account.token)).not.toBeNull();
  });
});
describe('scope enforcement reaches the database and precedes downstream execution', () => {
  it('A token cannot access B, even when the same user owns both workspaces', async () => {
    const a = (await issueInstallToken(linkId, 'codex'))!;
    const request = (ws: string, tk: string) => new Request(`http://localhost/api/v1/plugin/baseline?workspace=${ws}&toolkit=${tk}`, { headers: { authorization: `Bearer ${a.token}` } });
    expect((await baselineGET(request(workspaceSlug, tkSlug))).status).toBe(200);
    for (const [ws, tk] of [[workspaceSlug, 'other'], [otherWorkspaceSlug, tkSlug]]) {
      expect((await baselineGET(request(ws, tk))).status).toBe(404);
      const mcp = new Request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dep__tool', arguments: {} } }) });
      expect((await mcpPOST(mcp, { params: Promise.resolve({ slug: ws, toolkitSlug: tk }) })).status).toBe(404);
    }
    expect(downstream.rpc).not.toHaveBeenCalled(); expect(downstream.list).not.toHaveBeenCalled();
  });
  it('disabled toolkits and closed workspaces immediately invalidate their scoped tokens', async () => {
    const a = (await issueInstallToken(linkId, 'codex'))!;
    await db.toolkit.update({ where: { id: toolkitId }, data: { enabled: false } }); expect(await valid(a.token)).toBeNull();
    await db.toolkit.update({ where: { id: toolkitId }, data: { enabled: true } });
    await db.workspace.update({ where: { id: workspaceId }, data: { status: 'deleting' } }); expect(await valid(a.token)).toBeNull();
  });
  it('cross-origin and malformed registration requests cannot mint credentials', async () => {
    const request = management({ client: 'codex' }, 'unused'); request.headers.set('origin', 'https://untrusted.example');
    expect((await installPOST(request, { params: Promise.resolve({ id: linkId }) })).status).toBe(403);
    expect(await db.apiToken.count({ where: { userId } })).toBe(0);
  });
});
