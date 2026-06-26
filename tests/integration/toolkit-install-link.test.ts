// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { hashToken } from '@/lib/auth/tokens';
import { getOrCreateToolkitInstallLink } from '@/lib/toolkits/install-link';
import { GET as installGET } from '@/app/install/[id]/route';
import { GET as uninstallGET } from '@/app/install/[id]/uninstall/route';

let userId = '';
let workspaceId = '';
let toolkitId = '';
let tkSlug = '';
const stamp = Date.now();

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `instlink-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: {
      slug: `instlink-${stamp}`,
      name: 'IL',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = ws.id;
  tkSlug = `kit-${stamp}`;
  const toolkit = await db.toolkit.create({
    data: { workspaceId, slug: tkSlug, name: 'Kit' },
  });
  toolkitId = toolkit.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

const KEY_NAME = () => `MCPmarket plugin - ${tkSlug} (Claude Code)`;

function install(id: string) {
  return installGET(new Request(`http://localhost/install/${id}`), {
    params: Promise.resolve({ id }),
  });
}
function uninstall(id: string) {
  return uninstallGET(new Request(`http://localhost/install/${id}/uninstall`), {
    params: Promise.resolve({ id }),
  });
}
// Pull the embedded Bearer token out of the script's base64 .mcp.json blob.
function tokenFromScript(body: string): string {
  const m = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$PLUGIN_DIR\/\.mcp\.json"/.exec(body);
  const mcp = JSON.parse(Buffer.from(m![1], 'base64').toString('utf8'));
  return mcp.mcpServers[`mcpmarket-${tkSlug}`].headers.Authorization.replace('Bearer ', '');
}

describe('toolkit install link (mint-on-fetch named key)', () => {
  it('get-or-create is idempotent and mints NO token up front', async () => {
    const a = await getOrCreateToolkitInstallLink(toolkitId, userId);
    const b = await getOrCreateToolkitInstallLink(toolkitId, userId);
    expect(a.id).toBe(b.id);
    expect(a.id.length).toBeGreaterThan(20);
    expect(await db.apiToken.count({ where: { userId } })).toBe(0);
  });

  it('each install fetch mints the named key and embeds a valid token', async () => {
    const link = await getOrCreateToolkitInstallLink(toolkitId, userId);
    const res = await install(link.id);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`claude plugin install mcpmarket-${tkSlug}@mcpmarket-${tkSlug}`);

    const token = tokenFromScript(body);
    const row = await db.apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { name: true },
    });
    expect(row?.name).toBe(KEY_NAME());
  });

  it('re-installing overwrites the key (one row, rotated token)', async () => {
    const link = await getOrCreateToolkitInstallLink(toolkitId, userId);
    const t1 = tokenFromScript(await (await install(link.id)).text());
    const t2 = tokenFromScript(await (await install(link.id)).text());
    expect(t1).not.toBe(t2);
    expect(await db.apiToken.count({ where: { userId, name: KEY_NAME() } })).toBe(1);
  });

  it('uninstall revokes the key(s) and returns a removal script', async () => {
    const link = await getOrCreateToolkitInstallLink(toolkitId, userId);
    await install(link.id); // ensure a key exists
    const res = await uninstall(link.id);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`claude plugin uninstall mcpmarket-${tkSlug}@mcpmarket-${tkSlug}`);
    expect(body).toContain('rm -rf');
    expect(
      await db.apiToken.count({
        where: { userId, name: { startsWith: `MCPmarket plugin - ${tkSlug} (` } },
      }),
    ).toBe(0);
  });

  it('404s an unknown install id (install + uninstall)', async () => {
    expect((await install('nope')).status).toBe(404);
    expect((await uninstall('nope')).status).toBe(404);
  });
});
