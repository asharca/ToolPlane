import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Real production app, database, server actions and browser. No route interception or backend stubs.
const origin = 'http://127.0.0.1:3000';
assert.equal(process.env.TOOLPLANE_UI_E2E, '1', 'Explicit isolated-test opt-in is required.');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.equal(database.pathname, '/toolplane_ui_e2e');
assert.equal(database.search, '');
assert.equal(process.env.NEXT_PUBLIC_APP_URL, origin, 'Do not use an existing deployment.');
assert.ok(process.env.UI_BROWSER_TOOLS && process.env.UI_E2E_PASSWORD);
const require = createRequire(path.join(path.resolve(process.env.UI_BROWSER_TOOLS), 'package.json'));
const { chromium } = require('playwright');
const output = path.resolve('.playwright-cli/ui-ci');
await mkdir(output, { recursive: true });
const log = createWriteStream(path.join(output, 'app.log'));
const server = spawn(process.execPath, ['scripts/start-server.cjs'], {
  env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3000' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
const results = [];
let browser;
let page;
async function check(name, action) {
  try { await action(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: String(error) }); throw error; }
}
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Application exited ${server.exitCode}; see app.log`);
    try { if ((await fetch(`${origin}/api/v1/readiness`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* bounded startup retry */ }
    await delay(1000);
  }
  throw new Error('Application did not become ready; runtime recovery was not bypassed.');
}
async function login(context, email) {
  const result = await context.newPage();
  await result.goto(`${origin}/app/login?next=${encodeURIComponent('/app/ui-browser/toolkits')}`);
  await result.getByLabel('Email', { exact: true }).fill(email);
  await result.getByLabel('Password', { exact: true }).fill(process.env.UI_E2E_PASSWORD);
  await result.getByRole('button', { name: 'Sign in', exact: true }).click();
  await result.waitForURL('**/app/ui-browser/toolkits*');
  await result.getByRole('main').waitFor();
  return result;
}
async function noPageOverflow(target) {
  assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, 'Page must not overflow horizontally.');
}
try {
  await ready();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  context.on('page', p => p.on('pageerror', e => errors.push(String(e))));
  await check('unauthenticated workspace access redirects to login', async () => {
    page = await context.newPage(); await page.goto(`${origin}/app/ui-browser/toolkits`);
    assert.ok(new URL(page.url()).pathname.startsWith('/app/login')); await page.close();
  });
  await check('native login form authenticates against the real server', async () => { page = await login(context, 'owner@ui-e2e.invalid'); });
  await check('registry shell and tabs render with a linked active panel', async () => {
    await page.locator('[data-workspace-shell]').waitFor();
    const tab = page.getByRole('tab', { name: 'Toolkits', exact: true });
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), await tab.getAttribute('id'));
    await noPageOverflow(page);
    const field = page.getByPlaceholder('Search toolkits...');
    const geometry = await field.evaluate(el => {
      const icon = el.parentElement.querySelector('svg');
      return { textStart: el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft), iconEnd: icon.getBoundingClientRect().right };
    });
    assert.ok(geometry.textStart >= geometry.iconEnd + 4, 'Search text must not overlap its icon.');
    await page.screenshot({ path: path.join(output, 'desktop-workspace.png') });
  });
  await check('create toolkit via FormData and verify persisted result after reload', async () => {
    await page.getByRole('button', { name: 'New Toolkit', exact: true }).first().click();
    await page.getByLabel('Toolkit name', { exact: true }).fill('Browser Toolkit');
    await page.getByRole('button', { name: 'Create toolkit', exact: true }).click();
    await page.waitForURL('**/toolkits/browser-toolkit*');
    await page.goto(`${origin}/app/ui-browser/toolkits`);
    await page.getByRole('link', { name: 'Browser Toolkit', exact: true }).waitFor();
    await page.reload(); await page.getByRole('link', { name: 'Browser Toolkit', exact: true }).waitFor();
  });
  await check('filter table and preserve rows when clearing the native input', async () => {
    const search = page.getByPlaceholder('Search toolkits...'); await search.fill('absent-toolkit');
    await page.getByText('No toolkits match "absent-toolkit".', { exact: true }).waitFor();
    await search.fill('Browser'); await page.getByRole('link', { name: 'Browser Toolkit', exact: true }).waitFor();
  });
  await check('availability submit button persists once without navigation or stray form submits', async () => {
    await page.getByRole('button', { name: 'Disable Browser Toolkit', exact: true }).click();
    await page.getByRole('button', { name: 'Enable Browser Toolkit', exact: true }).waitFor();
    await page.reload(); await page.getByRole('button', { name: 'Enable Browser Toolkit', exact: true }).waitFor();
  });
  await check('pin, new tab, keyboard navigation and closing retain host routing', async () => {
    await page.getByRole('button', { name: 'Pin Toolkits', exact: true }).click();
    await page.getByRole('button', { name: 'Unpin Toolkits', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.waitForURL('**/chat*');
    await page.getByRole('tab', { name: 'Assistants', exact: true }).press('Home');
    await page.waitForURL('**/toolkits*');
    assert.equal(await page.getByRole('tab', { name: 'Toolkits', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Toolkits', exact: true }).press('Delete');
    assert.equal(await page.getByRole('tab', { name: 'Toolkits', exact: true }).count(), 1);
    await page.getByRole('tab', { name: 'Toolkits', exact: true }).press('End');
    await page.waitForURL('**/chat*');
    await page.getByRole('button', { name: 'Close Assistants', exact: true }).click();
    await page.waitForURL('**/toolkits*');
  });
  await check('sidebar folding preserves a live unsaved form and its input node', async () => {
    await page.getByRole('button', { name: 'New Toolkit', exact: true }).first().click();
    const draft = page.getByLabel('Toolkit name', { exact: true }); await draft.fill('Unsubmitted draft');
    await draft.evaluate(el => { el.dataset.browserIdentity = 'draft-kept'; });
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    assert.equal(await draft.inputValue(), 'Unsubmitted draft'); assert.equal(await draft.getAttribute('data-browser-identity'), 'draft-kept');
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    assert.equal(await draft.inputValue(), 'Unsubmitted draft');
    await page.locator('#toolkit-create-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('A2A settings show the disabled service without enabling or executing it', async () => {
    await page.goto(`${origin}/app/ui-browser/agents/ui-agent?settings=a2a`);
    await page.getByRole('dialog').waitFor();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Internal collaboration', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Enable internal A2A', exact: true }).isDisabled(), true);
    await dialog.getByText('Configure a model provider, model and exactly one exclusive networked Docker sandbox first.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'desktop-a2a-settings.png') });
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  });
  await check('remaining feature entry pages render without runtime or model execution', async () => {
    for (const segment of ['skills', 'mcp', 'sandboxes', 'providers', 'knowledge', 'members', 'market', 'work']) {
      const response = await page.goto(`${origin}/app/ui-browser/${segment}`);
      assert.ok(response && response.status() < 400, `${segment} returned ${response?.status()}`);
      await page.getByRole('main').waitFor();
      assert.equal(await page.getByRole('main').count(), 1, `${segment} must have exactly one main landmark`);
      await noPageOverflow(page);
    }
    const response = await page.goto(`${origin}/admin`); assert.ok(response && response.status() < 400);
  });
  await check('member UI does not expose publishing or destructive management controls', async () => {
    const member = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
    const p = await login(member, 'reader@ui-e2e.invalid');
    await p.getByRole('link', { name: 'Browser Toolkit', exact: true }).waitFor();
    assert.equal(await p.getByRole('button', { name: /^(Publish|Enable|Disable) Browser Toolkit$/ }).count(), 0);
    await p.goto(`${origin}/admin`); assert.equal(new URL(p.url()).pathname, '/');
    await member.close();
  });
  await check('mobile drawer traps focus, navigates and restores the opener on Escape', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/app/ui-browser/toolkits`);
    const opener = page.getByRole('button', { name: 'Open menu', exact: true }); await opener.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true }); await drawer.waitFor();
    assert.equal(await drawer.getAttribute('aria-modal'), 'true');
    for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); assert.equal(await drawer.evaluate(el => el.contains(document.activeElement)), true); }
    await page.screenshot({ path: path.join(output, 'mobile-navigation.png') });
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate(el => el === document.activeElement), true);
    await opener.click(); await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('link', { name: 'Skills', exact: true }).click();
    await page.waitForURL('**/skills*'); await noPageOverflow(page);
    await page.screenshot({ path: path.join(output, 'mobile-skills.png') });
  });
  await check('dark mobile theme has readable, nonoverflowing native controls', async () => {
    await page.evaluate(() => localStorage.setItem('theme', 'dark')); await page.reload();
    await page.locator('html.dark').waitFor(); await noPageOverflow(page);
    await page.screenshot({ path: path.join(output, 'mobile-dark.png') });
    assert.equal(errors.length, 0, `Unhandled browser errors: ${errors.join('; ')}`);
  });
  await check('light mobile theme keeps the workspace surface and fields visible', async () => {
    await page.evaluate(() => localStorage.setItem('theme', 'light')); await page.reload();
    await page.locator('html.light').waitFor(); await noPageOverflow(page);
    await page.screenshot({ path: path.join(output, 'mobile-light.png') });
    assert.equal(errors.length, 0, `Unhandled browser errors: ${errors.join('; ')}`);
  });
  await context.close();
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); }
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ results, limitations: ['No real model, CLI tool, external Agent or third-party messaging execution is claimed.'], source: process.env.GITHUB_SHA ?? null }, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
  for (let attempt = 0; attempt < 55 && server.exitCode === null; attempt++) await delay(1000);
  if (server.exitCode === null) server.kill('SIGKILL');
  log.end();
}
