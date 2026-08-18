// E2E: import the 43-skill reverse-skill suite from GitHub through the real UI.
// Run with the dev server up:  node e2e/skill-import.e2e.mjs
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const REPO_URL = 'https://github.com/zhaoxuya520/reverse-skill/tree/main/skills';
const email = `e2e-skill-${Date.now()}@example.com`;
const password = 'password1234';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ baseURL: BASE });
page.setDefaultTimeout(30000);

try {
  await page.goto('/app/signup');
  await page.fill('input[name="name"]', 'E2E Skill User');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/app/**/mcp', { timeout: 30000 });

  let slug = '';
  await page.goto('/app');
  await page.waitForURL('**/app/**/mcp', { timeout: 30000 });
  const m = /\/app\/([^/]+)\/mcp/.exec(page.url());
  assert(m, `expected /app/<slug>/mcp, got ${page.url()}`);
  slug = m[1];

  await page.goto(`/app/${slug}/skills`);
  await page.getByRole('button', { name: 'Add skill' }).first().click();
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  await page.fill('input[name="repo"]', REPO_URL);
  await page.getByRole('button', { name: 'Import' }).click();

  const start = Date.now();
  await page.waitForFunction(
    () => document.querySelector('[role="alert"]') !== null || location.search.includes('imported='),
    null,
    { timeout: 300000 },
  );
  console.log(`action settled after ${((Date.now() - start) / 1000).toFixed(1)}s, url: ${page.url()}`);
  const alert = await page.locator('[role="alert"]').first().textContent().catch(() => null);
  assert(!alert, `import error: ${alert}`);
  assert(page.url().includes('imported='), 'no redirect to imported skills');
  const ids = new URL(page.url()).searchParams.get('imported')?.split(',').length ?? 0;
  console.log(`imported=${ids} skills`);
  assert(ids === 43, `expected 43 imported ids, got ${ids}`);

  console.log('PASS — reverse-skill/skills imported via UI');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  await page.screenshot({ path: 'e2e/skill-import-failure.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
