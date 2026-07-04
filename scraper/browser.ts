import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const BASE_URL = process.env.SCRAPER_BASE_URL ?? 'https://example.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Use whatever Chromium revision is already cached on disk, to avoid a network
// download when Playwright's expected revision differs from the cached one.
function findCachedChromium(): string | undefined {
  const base = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const exe = join(
      base,
      dir,
      'chrome-mac',
      'Chromium.app',
      'Contents',
      'MacOS',
      'Chromium',
    );
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

let browser: Browser | null = null;

async function ensureBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: process.env.SCRAPE_HEADLESS !== 'false',
      executablePath: findCachedChromium(),
    });
  }
  return browser;
}

export async function fetchRenderedHtml(
  path: string,
  waitSelector = 'a[href^="/server/"] h3',
  attempts = 3,
): Promise<string> {
  const b = await ensureBrowser();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  let lastErr: unknown;

  // Fresh page per fetch avoids SPA state carrying over between navigations.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const page = await b.newPage({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector(waitSelector, { timeout: 20000 });
      return await page.content();
    } catch (err) {
      lastErr = err;
    } finally {
      await page.close();
    }
  }
  throw lastErr ?? new Error(`failed to load ${url}`);
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
