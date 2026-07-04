# ToolPlane — P1a Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project scaffold, PostgreSQL data layer, typed read-query layer, and the scraper core — a fully tested foundation that later UI plans render from.

**Architecture:** A single Next.js App Router app. PostgreSQL via Prisma (Docker locally). A standalone, rate-limited scraper ingests public MCP directory source into the DB. The web layer reads only through `src/lib/queries/*`. This plan (P1a) builds scaffold + DB + queries + scraper core. UI/pages come in P1b/P1c.

**Tech Stack:** Next.js (App Router) · TypeScript · Tailwind CSS · Prisma · PostgreSQL · cheerio · Vitest + React Testing Library · Playwright (e2e, used in later plans) · pnpm.

**Plan series:** P1a Foundation (this) → P1b design-system + shell + home → P1c remaining directory pages.

---

## File Structure (built by this plan)

- `docker-compose.yml` — local Postgres (dev + test DBs)
- `.env`, `.env.example` — `DATABASE_URL`
- `prisma/schema.prisma` — schema (Server, Client, Skill, Category, DailySnapshot, ScrapeCheckpoint)
- `src/lib/db.ts` — Prisma client singleton
- `src/lib/queries/servers.ts` — `listServers`, `getServer`
- `src/lib/queries/search.ts` — `searchAll`
- `scraper/rate-limit.ts` — `Throttle` (delay + backoff)
- `scraper/parse.ts` — pure HTML→entity parsers
- `scraper/ingest.ts` — checkpointed upsert
- `tests/**` — unit + integration
- `vitest.config.ts`, `vitest.setup.ts`

---

### Task 1: Project scaffold (Next.js + TS + Tailwind + Vitest)

**Files:**
- Create: whole Next.js app under `toolplane/` (merged with existing `docs/`, `.git`)
- Create: `vitest.config.ts`, `vitest.setup.ts`
- Test: `tests/unit/smoke.test.ts`

- [ ] **Step 1: Scaffold Next.js into a temp dir and merge (keeps existing `docs/` + `.git`)**

```bash
cd /Users/ashark/Code/toolplane
pnpm create next-app@latest /tmp/mm-scaffold \
  --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --no-turbopack
rsync -a --exclude '.git' /tmp/mm-scaffold/ ./
rm -rf /tmp/mm-scaffold
pnpm install
```

- [ ] **Step 2: Add test tooling**

```bash
pnpm add -D vitest @vitejs/plugin-react jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
```

- [ ] **Step 4: Write `vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Write the smoke test**

```ts
// tests/unit/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Add the test script to `package.json`**

Add under `"scripts"`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 7: Run the smoke test**

Run: `pnpm test`
Expected: PASS (1 passed).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Tailwind and Vitest"
```

---

### Task 2: Local PostgreSQL via Docker + env

**Files:**
- Create: `docker-compose.yml`, `.env`, `.env.example`
- Modify: `.gitignore` (ensure `.env` ignored)

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    container_name: toolplane-pg
    restart: unless-stopped
    environment:
      POSTGRES_USER: mcp
      POSTGRES_PASSWORD: mcp
      POSTGRES_DB: toolplane
    ports:
      - '5433:5432'
    volumes:
      - mcp_pg:/var/lib/postgresql/data
volumes:
  mcp_pg:
```

- [ ] **Step 2: Write `.env.example`**

```bash
DATABASE_URL="postgresql://mcp:mcp@localhost:5433/toolplane?schema=public"
```

- [ ] **Step 3: Create `.env` from it**

```bash
cp .env.example .env
grep -q '^\.env$' .gitignore || echo '.env' >> .gitignore
```

- [ ] **Step 4: Start Postgres and verify it accepts connections**

```bash
docker compose up -d
sleep 3
docker exec toolplane-pg pg_isready -U mcp
```
Expected: `... accepting connections`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example .gitignore
git commit -m "chore: add local Postgres via Docker Compose"
```

---

### Task 3: Prisma schema + migration

**Files:**
- Create: `prisma/schema.prisma`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Install Prisma**

```bash
pnpm add -D prisma
pnpm add @prisma/client
```

- [ ] **Step 2: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Server {
  id          String     @id @default(cuid())
  slug        String     @unique
  name        String
  author      String?
  description String?
  iconUrl     String?
  stars       Int        @default(0)
  isOfficial  Boolean    @default(false)
  isFeatured  Boolean    @default(false)
  installCfg  Json?
  readme      String?
  categories  Category[] @relation("ServerCategories")
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model Client {
  id          String     @id @default(cuid())
  slug        String     @unique
  name        String
  author      String?
  description String?
  iconUrl     String?
  stars       Int        @default(0)
  categories  Category[] @relation("ClientCategories")
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model Skill {
  id          String     @id @default(cuid())
  slug        String     @unique
  name        String
  author      String?
  description String?
  iconUrl     String?
  score       Int        @default(0)
  categories  Category[] @relation("SkillCategories")
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model Category {
  id      String   @id @default(cuid())
  slug    String   @unique
  name    String
  servers Server[] @relation("ServerCategories")
  clients Client[] @relation("ClientCategories")
  skills  Skill[]  @relation("SkillCategories")
}

model DailySnapshot {
  id         String   @id @default(cuid())
  entityType String
  entityId   String
  date       DateTime @db.Date
  rank       Int
  score      Int
  @@unique([entityType, entityId, date])
}

model ScrapeCheckpoint {
  id        String   @id @default(cuid())
  job       String   @unique
  lastSlug  String?
  doneCount Int      @default(0)
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 3: Create and apply the migration**

```bash
pnpm prisma migrate dev --name init
```
Expected: migration created under `prisma/migrations/`, client generated, "Your database is now in sync".

- [ ] **Step 4: Add Prisma scripts to `package.json`**

Add under `"scripts"`: `"db:migrate": "prisma migrate dev"`, `"db:generate": "prisma generate"`, `"db:studio": "prisma studio"`.

- [ ] **Step 5: Commit**

```bash
git add prisma package.json pnpm-lock.yaml
git commit -m "feat: add Prisma schema and initial migration"
```

---

### Task 4: Prisma client singleton

**Files:**
- Create: `src/lib/db.ts`
- Test: `tests/integration/db.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/db.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/db';

describe('db client', () => {
  afterAll(async () => { await db.$disconnect(); });

  it('connects and counts servers', async () => {
    const count = await db.server.count();
    expect(typeof count).toBe('number');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/integration/db.test.ts`
Expected: FAIL — cannot resolve `@/lib/db`.

- [ ] **Step 3: Write `src/lib/db.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
```

- [ ] **Step 4: Run the test (Postgres must be up)**

```bash
docker compose up -d
pnpm test tests/integration/db.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts tests/integration/db.test.ts
git commit -m "feat: add Prisma client singleton"
```

---

### Task 5: Scraper throttle (delay + backoff)

**Files:**
- Create: `scraper/rate-limit.ts`
- Test: `tests/unit/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../../scraper/rate-limit';

describe('backoffDelay', () => {
  it('grows exponentially from a base, capped', () => {
    expect(backoffDelay(0, 1000, 30000)).toBe(1000);
    expect(backoffDelay(1, 1000, 30000)).toBe(2000);
    expect(backoffDelay(2, 1000, 30000)).toBe(4000);
    expect(backoffDelay(10, 1000, 30000)).toBe(30000); // capped
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/unit/rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scraper/rate-limit.ts`**

```ts
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Throttle {
  private last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const gap = now - this.last;
    if (gap < this.minIntervalMs) await sleep(this.minIntervalMs - gap);
    this.last = Date.now();
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test tests/unit/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scraper/rate-limit.ts tests/unit/rate-limit.test.ts
git commit -m "feat: add scraper throttle and backoff"
```

---

### Task 6: Scraper server-card parser (pure)

**Files:**
- Create: `scraper/parse.ts`
- Test: `tests/unit/parse.test.ts`, `tests/fixtures/server-card.html`

- [ ] **Step 1: Install cheerio**

```bash
pnpm add cheerio
```

- [ ] **Step 2: Create the fixture `tests/fixtures/server-card.html`**

```html
<a href="/server/firecrawl">
  <h3>Firecrawl</h3>
  <img alt="mendableai" src="https://img/firecrawl.png" />
  <p>Empowers LLMs with advanced web scraping capabilities.</p>
  <span data-category>Web Scraping &amp; Data Collection</span>
  <span data-stars>4.2k</span>
</a>
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/unit/parse.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseServerCard, parseStars } from '../../scraper/parse';

const html = readFileSync(resolve(__dirname, '../fixtures/server-card.html'), 'utf8');

describe('parseStars', () => {
  it('parses k-suffixed counts', () => {
    expect(parseStars('4.2k')).toBe(4200);
    expect(parseStars('12k')).toBe(12000);
    expect(parseStars('0')).toBe(0);
  });
});

describe('parseServerCard', () => {
  it('extracts fields from a card anchor', () => {
    const s = parseServerCard(html);
    expect(s).toEqual({
      slug: 'firecrawl',
      name: 'Firecrawl',
      author: 'mendableai',
      description: 'Empowers LLMs with advanced web scraping capabilities.',
      iconUrl: 'https://img/firecrawl.png',
      category: 'Web Scraping & Data Collection',
      stars: 4200,
    });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm test tests/unit/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write `scraper/parse.ts`**

```ts
import * as cheerio from 'cheerio';

export interface ParsedServerCard {
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  category: string | null;
  stars: number;
}

export function parseStars(text: string): number {
  const t = text.trim().toLowerCase();
  if (t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
  return parseInt(t, 10) || 0;
}

export function parseServerCard(html: string): ParsedServerCard {
  const $ = cheerio.load(html);
  const a = $('a').first();
  const href = a.attr('href') ?? '';
  const slug = href.split('/').filter(Boolean).pop() ?? '';
  const img = a.find('img').first();
  const starsText = a.find('[data-stars]').first().text();
  return {
    slug,
    name: a.find('h3').first().text().trim(),
    author: img.attr('alt')?.trim() || null,
    description: a.find('p').first().text().trim() || null,
    iconUrl: img.attr('src') || null,
    category: a.find('[data-category]').first().text().trim() || null,
    stars: starsText ? parseStars(starsText) : 0,
  };
}
```

- [ ] **Step 6: Run the test**

Run: `pnpm test tests/unit/parse.test.ts`
Expected: PASS.

> Note: real toolplane markup uses generated class names, not `data-` attributes. During implementation, replace the fixture with real saved HTML and adjust the selectors so the test still asserts the same `ParsedServerCard` shape.

- [ ] **Step 7: Commit**

```bash
git add scraper/parse.ts tests/unit/parse.test.ts tests/fixtures/server-card.html package.json pnpm-lock.yaml
git commit -m "feat: add server-card parser"
```

---

### Task 7: Scraper ingest (checkpointed upsert)

**Files:**
- Create: `scraper/ingest.ts`
- Test: `tests/integration/ingest.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/ingest.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { upsertServer } from '../../scraper/ingest';
import type { ParsedServerCard } from '../../scraper/parse';

const card: ParsedServerCard = {
  slug: 'firecrawl', name: 'Firecrawl', author: 'mendableai',
  description: 'desc', iconUrl: 'https://img/x.png',
  category: 'Web Scraping & Data Collection', stars: 4200,
};

describe('upsertServer', () => {
  beforeEach(async () => {
    await db.server.deleteMany({ where: { slug: 'firecrawl' } });
  });
  afterAll(async () => { await db.$disconnect(); });

  it('creates then updates idempotently and links category', async () => {
    await upsertServer(card);
    await upsertServer({ ...card, stars: 5000 }); // second run updates
    const s = await db.server.findUnique({
      where: { slug: 'firecrawl' }, include: { categories: true },
    });
    expect(s?.stars).toBe(5000);
    expect(s?.categories[0]?.name).toBe('Web Scraping & Data Collection');
    const dupes = await db.server.count({ where: { slug: 'firecrawl' } });
    expect(dupes).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/integration/ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scraper/ingest.ts`**

```ts
import { db } from '@/lib/db';
import type { ParsedServerCard } from './parse';

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function categoryConnect(name: string | null) {
  if (!name) return undefined;
  const slug = slugify(name);
  return {
    connectOrCreate: [{ where: { slug }, create: { slug, name } }],
  };
}

export async function upsertServer(card: ParsedServerCard): Promise<void> {
  const categories = await categoryConnect(card.category);
  await db.server.upsert({
    where: { slug: card.slug },
    create: {
      slug: card.slug, name: card.name, author: card.author,
      description: card.description, iconUrl: card.iconUrl, stars: card.stars,
      ...(categories ? { categories } : {}),
    },
    update: {
      name: card.name, author: card.author, description: card.description,
      iconUrl: card.iconUrl, stars: card.stars,
      ...(categories ? { categories: { set: [], ...categories } } : {}),
    },
  });
}

export async function setCheckpoint(job: string, lastSlug: string, doneCount: number): Promise<void> {
  await db.scrapeCheckpoint.upsert({
    where: { job },
    create: { job, lastSlug, doneCount },
    update: { lastSlug, doneCount },
  });
}
```

- [ ] **Step 4: Run the test (Postgres up)**

Run: `pnpm test tests/integration/ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scraper/ingest.ts tests/integration/ingest.test.ts
git commit -m "feat: add checkpointed server ingest"
```

---

### Task 8: Read-query layer (servers + search)

**Files:**
- Create: `src/lib/queries/servers.ts`, `src/lib/queries/search.ts`
- Test: `tests/integration/queries.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/queries.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { listServers, getServer } from '@/lib/queries/servers';
import { searchAll } from '@/lib/queries/search';

beforeAll(async () => {
  await db.server.upsert({
    where: { slug: 'firecrawl' },
    create: { slug: 'firecrawl', name: 'Firecrawl', description: 'web scraping', stars: 4200 },
    update: {},
  });
});
afterAll(async () => { await db.$disconnect(); });

describe('queries', () => {
  it('lists servers ordered by stars with paging', async () => {
    const { items, total } = await listServers({ page: 1, pageSize: 10 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items[0]).toHaveProperty('slug');
  });

  it('gets a server by slug', async () => {
    const s = await getServer('firecrawl');
    expect(s?.name).toBe('Firecrawl');
  });

  it('returns null for unknown slug', async () => {
    expect(await getServer('does-not-exist')).toBeNull();
  });

  it('searches servers by name/description (case-insensitive)', async () => {
    const res = await searchAll('FIRE');
    expect(res.servers.some((s) => s.slug === 'firecrawl')).toBe(true);
  });

  it('returns empty results for blank query without hitting filters', async () => {
    const res = await searchAll('   ');
    expect(res.servers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/integration/queries.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/lib/queries/servers.ts`**

```ts
import { db } from '@/lib/db';

export interface ListOpts { page: number; pageSize: number; }

export async function listServers(opts: ListOpts) {
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize));
  const [items, total] = await Promise.all([
    db.server.findMany({
      orderBy: { stars: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { categories: true },
    }),
    db.server.count(),
  ]);
  return { items, total, page, pageSize };
}

export async function getServer(slug: string) {
  return db.server.findUnique({ where: { slug }, include: { categories: true } });
}
```

- [ ] **Step 4: Write `src/lib/queries/search.ts`**

```ts
import { db } from '@/lib/db';

export async function searchAll(query: string) {
  const q = query.trim();
  if (!q) return { servers: [], clients: [], skills: [] };
  const where = {
    OR: [
      { name: { contains: q, mode: 'insensitive' as const } },
      { description: { contains: q, mode: 'insensitive' as const } },
    ],
  };
  const [servers, clients, skills] = await Promise.all([
    db.server.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.client.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.skill.findMany({ where, take: 50, orderBy: { score: 'desc' } }),
  ]);
  return { servers, clients, skills };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm test tests/integration/queries.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 6: Run the full suite**

```bash
pnpm test
```
Expected: all tasks' tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/queries tests/integration/queries.test.ts
git commit -m "feat: add server and search read queries"
```

---

## Self-Review

**Spec coverage (P1a portion):** scaffold ✓ (T1), Postgres ✓ (T2), schema/all entities ✓ (T3), db client ✓ (T4), scraper throttle+backoff/429 handling ✓ (T5), pure parser unit-test seam ✓ (T6), checkpointed idempotent ingest ✓ (T7), read-query layer + search empty-state validation ✓ (T8). Deferred to P1b/P1c: design tokens, shell, pages, enumerate/fetch crawl driver, client/skill parsers, leaderboard/daily queries, E2E. (Tracked in the spec's build order; not P1a.)

**Placeholder scan:** none — every code step has complete code; the one real-markup caveat in T6 is an explicit implementation note, not a deferred step.

**Type consistency:** `ParsedServerCard` defined in T6 is consumed unchanged in T7; `listServers`/`getServer`/`searchAll` signatures match their tests; `db` import path `@/lib/db` consistent across T4/T7/T8. Scraper tests import scraper modules by relative path (`../../scraper/*`) since the `@` alias maps to `src/` only.

---

## Next plans (not in scope here)
- **P1b:** design tokens from real site → Tailwind config; `Header`/`Footer`/`ThemeToggle`/`Banner`/`MegaMenu`; `ServerCard`/`SkillCard`/`ClientCard`; home page; `getHomeSections()` query; first Playwright e2e.
- **P1c:** `/server` + detail, `/client` + detail, `/tools/skills` + detail + leaderboard, `/categories`, `/search`, `/leaderboards`, `/daily`; remaining parsers + crawl driver (`enumerate.ts`, `fetch-detail.ts`) + full catalog scrape; pixel-diff pass.
