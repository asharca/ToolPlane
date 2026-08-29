// Self-contained Playwright e2e for the Hub dashboard. Uses the installed
// `playwright` library (no @playwright/test needed) and drives the live dev
// server at BASE. Signs up a fresh user each run so it is independent of seed
// data, then exercises deploy -> running -> stop -> start -> install skill.
//
// Run with the dev server up:  npm run test:e2e
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const email = `e2e-${Date.now()}@example.com`;
const password = 'password1234';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const steps = [];
async function step(name, fn) {
  process.stdout.write(`• ${name} ... `);
  await fn();
  steps.push(name);
  process.stdout.write('ok\n');
}

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE, locale: 'en-US' });
await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: BASE }]);
const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await step('sign up a fresh user', async () => {
    await page.goto('/app/signup');
    await page.fill('input[name="name"]', 'E2E User');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL('**/app/**/chat', { timeout: 20000 });
  });

  let slug = '';
  await step('bootstrap workspace via /app', async () => {
    await page.goto('/app');
    await page.waitForURL('**/app/**/chat', { timeout: 20000 });
    const m = /\/app\/([^/]+)\//.exec(page.url());
    assert(m, `expected /app/<slug>/..., got ${page.url()}`);
    slug = m[1];
  });

  await step('deploy the first MCP server', async () => {
    await page.goto(`/app/${slug}/market/mcp`);
    await page.getByRole('button', { name: 'Add to workspace' }).first().click();
    await page.waitForURL(`**/app/${slug}/mcp/**`, { timeout: 20000 });
  });

  await step('deployed server shows Running', async () => {
    await page.goto(`/app/${slug}/mcp`);
    await page.locator('table').getByText('Running', { exact: true }).waitFor({ timeout: 60000 });
  });

  await step('stop the deployment', async () => {
    await page.locator('table').getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator('table').getByText('Stopped', { exact: true }).waitFor({ timeout: 60000 });
  });

  await step('start the deployment again', async () => {
    await page.locator('table').getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForURL(new RegExp(`/app/${slug}/mcp/[^/]+`), { timeout: 60000 });
    await page.locator('dl dd', { hasText: /^running$/ }).first().waitFor({ timeout: 60000 });
  });

  await step('install the first skill', async () => {
    await page.goto(`/app/${slug}/market/skills`);
    await page.getByRole('button', { name: 'Install' }).first().click();
    await page.getByText('Installed', { exact: true }).first().waitFor({ timeout: 20000 });
  });

  await step('installed skill appears with a download link', async () => {
    await page.goto(`/app/${slug}/skills`);
    await page.getByRole('link', { name: 'Download SKILL.md' }).first().waitFor({
      timeout: 20000,
    });
  });

  console.log(`\nPASS — ${steps.length} steps (${email})`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error(`\nFAIL after ${steps.length} steps: ${err.message}`);
  await page.screenshot({ path: 'e2e/failure.png' }).catch(() => {});
  await browser.close();
  process.exit(1);
}
