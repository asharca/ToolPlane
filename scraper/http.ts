import { backoffDelay, sleep } from './rate-limit';

const BASE_URL = 'https://mcpmarket.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; mcp-market-clone/0.1; personal-learning)';

export async function fetchHtml(path: string, maxRetries = 4): Promise<string> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        throw new Error(`fetch ${url} failed after retries: ${res.status}`);
      }
      await sleep(backoffDelay(attempt, 1000, 30000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: ${res.status}`);
    }
    return res.text();
  }
}
