import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from '../../src/lib/auth/password';

// This fixture must never target a configured deployment or a developer's normal database.
const connectionString = process.env.DATABASE_URL ?? '';
const url = new URL(connectionString);
if (process.env.TOOLPLANE_UI_E2E !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/toolplane_ui_e2e' || url.search || process.env.NODE_ENV === 'production') {
  throw new Error('UI fixtures require explicit opt-in and a dedicated loopback toolplane_ui_e2e database.');
}
const password = process.env.UI_E2E_PASSWORD;
if (!password || password.length < 12) throw new Error('Set a disposable UI_E2E_PASSWORD with at least 12 characters.');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  // Refuse reuse, rather than deleting or replacing pre-existing records.
  if (await db.user.count() !== 0 || await db.workspace.count() !== 0) throw new Error('The UI test database must be empty.');
  for (const [id, role] of [['owner', 'admin'], ['reader', 'user']] as const) {
    await db.user.create({ data: { id: `ui-${id}`, email: `${id}@ui-e2e.invalid`, name: `UI ${id}`, role,
      passwordHash: await hashPassword(password), locale: 'en' } });
  }
  await db.workspace.create({ data: { id: 'ui-workspace', slug: 'ui-browser', name: 'UI Browser Workspace', ownerId: 'ui-owner',
    members: { create: { userId: 'ui-reader', role: 'member' } } } });
  await db.agent.create({ data: { id: 'ui-agent', workspaceId: 'ui-workspace', slug: 'ui-agent', name: 'UI Agent', runtimeKind: 'pi',
    a2aInternalEnabled: false } });
  await db.installedSkill.create({ data: { id: 'ui-skill', workspaceId: 'ui-workspace', name: 'UI Fixture Skill', slug: 'ui-fixture',
    source: 'custom', content: '# UI fixture\n\nOnly used for browser verification.', files: [] } });
  console.log('Created isolated UI fixtures; no model credentials, deployments or enabled endpoints.');
} finally { await db.$disconnect(); }
