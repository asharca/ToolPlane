# ToolPlane — P1: Foundation + DB-backed Directory

**Date:** 2026-06-23
**Status:** Approved design (pending written-spec review)
**Goal of overall project:** Build ToolPlane as a self-hosted control plane for MCP directories, skills, toolkits, and agent runtimes. This spec covers **P1 only**.

---

## Context

public MCP directory source is a Next.js (App Router) + Tailwind directory site fronting ~37k MCP servers,
plus MCP clients and Agent Skills, with categories, search, leaderboards, and a Hub/gateway.
The product is decomposed into 5 phases:

- **P1 (this spec):** Foundation shell + data layer + DB-backed directory pages.
- P2: (folded into P1) data layer — now part of P1.
- P3: Accounts + `sk_user_…` API tokens.
- P4: Hub / gateway / Toolkits (remote streamable-HTTP MCP endpoint, Bearer auth, MCP aggregation, config generation).
- P5: Ancillary pages (`/submit`, `/sell`, `/news` CMS, `/privacy`, `/terms`, ads/affiliate).

Confirmed decisions for P1:
- **Database:** PostgreSQL (via Prisma). Local dev through Docker Compose.
- **Scope of first spec:** all directory entity types — Server, Client, Skill.
- **Theme:** dark + light both implemented.
- **i18n:** NOT in P1 (English only, no i18n scaffolding).
- **Data source:** scrape the public MCP directory source (full catalog) into the local DB. Personal/learning use only.
- **Stack:** Next.js App Router + TypeScript + Tailwind CSS (matches the real site).

---

## Scope

### In scope (P1)
Global shell + data layer + these routes, rendered from the real DB:

- `/` — home (Official / Featured / Top / Latest servers, Clients, Top Skills, FAQ)
- `/server`, `/server/[slug]` — server list + detail
- `/client`, `/client/[slug]` — client list + detail
- `/tools/skills`, `/tools/skills/[slug]`, `/tools/skills/leaderboard` — skills
- `/categories`, `/categories/[slug]` — category index + per-category listing
- `/search` — search across servers/clients/skills
- `/leaderboards`, `/daily`, `/daily/skills` — rankings

Global UI: header with mega-menu dropdowns, footer, dark/light theme toggle, top promo banner, newsletter modal, FAQ accordion.

### Out of scope (P1)
Auth / accounts, `sk_user_…` tokens, Hub / gateway / Toolkits, `/submit`, `/sell`, `/news`,
`/privacy`, `/terms`, advertise/affiliate modals, i18n. These are P3–P5.

---

## Architecture

Single Next.js App Router application with four internally-isolated units. No monorepo;
units are folders with well-defined interfaces.

```
toolplane/
  docker-compose.yml          # local Postgres
  prisma/
    schema.prisma             # DB schema (unit 2)
    seed.ts                   # optional small seed for tests
  src/
    app/                      # routes (unit 1: web)
    components/               # shared UI (unit 4: ui)
    lib/
      db.ts                   # Prisma client singleton
      queries/                # data-access layer (read API for web)
      design-tokens.ts        # extracted tokens (unit 4)
  scraper/                    # standalone ingestion (unit 3)
    enumerate.ts              # sitemap + category crawl -> slug list
    fetch-detail.ts           # fetch + parse one detail page
    parse.ts                  # pure HTML -> entity parsers (unit-tested)
    ingest.ts                 # upsert into DB, checkpointed
    rate-limit.ts             # throttle + backoff
  tests/
    unit/  integration/  e2e/
  docs/superpowers/specs/
```

### Unit 1 — `web/` (Next.js App Router frontend)
- **Does:** renders all P1 routes as React Server Components reading from the DB via `lib/queries`.
- **Interface:** route files under `src/app`; consumes `lib/queries/*` functions only (never Prisma directly in components).
- **Depends on:** `lib/queries`, `components/*`, Tailwind/design tokens.
- Rendering: SSR with ISR (`revalidate`) for list/detail pages; search is dynamic.

### Unit 2 — `db/` (Prisma + PostgreSQL)
- **Does:** defines schema, owns the Prisma client, exposes typed read queries.
- **Interface:** `lib/queries/*` (e.g. `getHomeSections()`, `listServers(opts)`, `getServer(slug)`, `searchAll(q)`, `getLeaderboard(kind)`, `getDaily(kind, date)`). The scraper writes; the web reads.
- **Depends on:** PostgreSQL (Docker locally; `DATABASE_URL` env). Swap to managed Postgres = change env only.

### Unit 3 — `scraper/` (ingestion, standalone)
- **Does:** enumerates all entity slugs from public MCP directory source (`sitemap.xml` + category/listing pages), fetches each detail page, parses to entities, upserts into the DB. Resumable via a checkpoint table.
- **Interface:** CLI scripts (`pnpm scrape:servers`, `:clients`, `:skills`, `:all`); `parse.ts` is a set of pure functions taking HTML → typed objects (the unit-test seam).
- **Depends on:** the live site, the DB. Decoupled from `web` — runs separately.
- **Politeness:** concurrency ≤ 2, ~1 req/s, exponential backoff on 429 (the real site returns 429 to automated traffic), `User-Agent` set, resume from last checkpoint.

### Unit 4 — `ui/` (design system)
- **Does:** design tokens extracted from the real site (palette, typography scale, spacing, radius, shadows for both themes) wired into `tailwind.config`, plus shared presentational components.
- **Interface:** exported React components — `ServerCard`, `ClientCard`, `SkillCard`, `CategoryPill`, `SectionHeader`, `SearchBar`, `MegaMenu`, `Header`, `Footer`, `ThemeToggle`, `Banner`, `NewsletterModal`, `FAQAccordion`.
- **Depends on:** Tailwind tokens only. No data access — pure props in.

---

## Data Model (Prisma sketch)

```prisma
model Server {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  author      String?
  description String?
  iconUrl     String?
  stars       Int      @default(0)
  isOfficial  Boolean  @default(false)
  isFeatured  Boolean  @default(false)
  installCfg  Json?            // install/config payload from detail page
  readme      String?          // detail page long content, if present
  categories  Category[] @relation("ServerCategories")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Client {
  id String @id @default(cuid())
  slug String @unique
  name String
  author String?
  description String?
  iconUrl String?
  stars Int @default(0)
  categories Category[] @relation("ClientCategories")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Skill {
  id String @id @default(cuid())
  slug String @unique
  name String
  author String?
  description String?
  iconUrl String?
  score Int @default(0)          // the "330k" usage/score number
  categories Category[] @relation("SkillCategories")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Category {
  id String @id @default(cuid())
  slug String @unique
  name String
  servers Server[] @relation("ServerCategories")
  clients Client[] @relation("ClientCategories")
  skills  Skill[]  @relation("SkillCategories")
}

// Rankings for /leaderboards, /daily, /daily/skills
model DailySnapshot {
  id String @id @default(cuid())
  entityType String   // "server" | "skill"
  entityId   String
  date       DateTime @db.Date
  rank       Int
  score      Int
  @@unique([entityType, entityId, date])
}

// Scraper resume support
model ScrapeCheckpoint {
  id String @id @default(cuid())
  job String   @unique   // "servers" | "clients" | "skills"
  lastSlug String?
  doneCount Int @default(0)
  updatedAt DateTime @updatedAt
}
```

FAQ and other static homepage copy are stored as constants in the codebase (not DB).

---

## Data Flow

```
scraper (enumerate -> fetch -> parse -> ingest)  --write-->  PostgreSQL
                                                                  |
web (Server Components) <-- read via lib/queries -----------------+
        |
        v
   rendered pages
```

---

## Product-grade fidelity approach

During implementation, per target page:
1. Load the real page in a browser; extract **computed** CSS (colors, font sizes, line-heights, spacing, breakpoints, radii, shadows) for both themes.
2. Populate `design-tokens.ts` / `tailwind.config` from those values.
3. Build the page, screenshot it, diff against the real page, iterate until visually matched.

Icons/logos for catalog entries come from the scraped `iconUrl`s.

---

## Error Handling

- **Scraper:** every fetch wrapped with retry + backoff; 429/5xx → backoff and resume; parse failures recorded (skip + log, never crash the run); checkpoint after each entity so a killed run resumes.
- **Queries:** missing slug → Next.js `notFound()` (404 page matching site style); DB unreachable → error boundary with a styled error page; never swallow errors silently.
- **Search:** empty/whitespace query → empty-state UI, no DB hit.
- **Input validation:** search query and pagination params validated/clamped at the route boundary (zod) before hitting the DB.

---

## Testing (TDD, 80%+ coverage target)

- **Unit:** `parse.ts` parsers against saved HTML fixtures; `rate-limit` backoff logic; each `ui/` component (render + props).
- **Integration:** `lib/queries/*` against a test Postgres (list, detail, search, category, leaderboard, daily); scraper `ingest` upsert idempotency.
- **E2E (Playwright):** home loads with all sections; search returns results; navigate into a server detail page. (3 golden paths.)
- Tooling: Vitest + React Testing Library; Playwright for E2E.

---

## Build order within P1 (for the implementation plan)

1. Scaffold Next.js + TS + Tailwind + Prisma + Docker Postgres; `db.ts`; CI/test harness.
2. Prisma schema + migration; `lib/queries` signatures with integration tests (RED).
3. Scraper: `parse.ts` (TDD against fixtures) → `enumerate`/`fetch`/`rate-limit` → `ingest`; run a small real crawl to populate dev DB.
4. Design tokens extracted from real site; Tailwind config; `Header`/`Footer`/`ThemeToggle`/`Banner` shell.
5. Shared cards + `SectionHeader` + `SearchBar` + `MegaMenu`.
6. Pages in order: home → `/server` + detail → `/client` + detail → `/tools/skills` + detail → `/categories` → `/search` → `/leaderboards` + `/daily`.
7. Full catalog scrape; pixel-diff pass per page; E2E green; coverage check.

---

## Non-goals / explicitly deferred

Auth, tokens, Hub/gateway, submit/sell, news CMS, legal pages, ads/affiliate, i18n, mobile-app —
all later phases. P1 is the directory experience only.
