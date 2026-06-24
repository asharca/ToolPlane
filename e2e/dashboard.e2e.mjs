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
const page = await browser.newPage({ baseURL: BASE });
page.setDefaultTimeout(20000);

try {
  await step('sign up a fresh user', async () => {
    await page.goto('/signup');
    await page.fill('input[name="name"]', 'E2E User');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL('**/account', { timeout: 20000 });
  });

  let slug = '';
  await step('bootstrap workspace via /app', async () => {
    await page.goto('/app');
    await page.waitForURL('**/app/**/mcp', { timeout: 20000 });
    const m = /\/app\/([^/]+)\/mcp/.exec(page.url());
    assert(m, `expected /app/<slug>/mcp, got ${page.url()}`);
    slug = m[1];
  });

  await step('deploy the first MCP server', async () => {
    await page.goto(`/app/${slug}/mcp/new`);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.getByText('Deployed').first().waitFor({ timeout: 20000 });
  });

  await step('deployed server shows Running', async () => {
    await page.goto(`/app/${slug}/mcp`);
    await page.getByText('Running').first().waitFor({ timeout: 20000 });
  });

  await step('stop the deployment', async () => {
    await page.getByRole('button', { name: 'Stop' }).first().click();
    await page.getByText('Stopped').first().waitFor({ timeout: 20000 });
  });

  await step('start the deployment again', async () => {
    await page.getByRole('button', { name: 'Start' }).first().click();
    await page.getByText('Running').first().waitFor({ timeout: 20000 });
  });

  await step('install the first skill', async () => {
    await page.goto(`/app/${slug}/skills/new`);
    await page.getByRole('button', { name: 'Install' }).first().click();
    await page.getByText('Installed').first().waitFor({ timeout: 20000 });
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
