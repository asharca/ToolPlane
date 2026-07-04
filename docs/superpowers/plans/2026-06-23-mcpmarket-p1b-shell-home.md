# toolplane P1b — Design System + Global Shell + Home Page

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax. This plan is executed **inline in the originating session** (cost-controlled) with `pnpm exec tsc --noEmit` + `pnpm test` review between tasks — not the full subagent-driven ceremony.

**Goal:** Build the Product-grade global shell (header/footer/theme) and home page of public MCP directory source on top of the P1a foundation.

**Architecture:** shadcn-style design tokens in Tailwind v4 `@theme`; global `Header`/`Footer`/`ThemeProvider` in the root layout; presentational `EntityCard` reused by `Server/Client/Skill` card wrappers; `getHomeSections()` DB query feeds a presentational `HomeView`. Server components fetch; client components only where interactivity is required (theme toggle).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS v4 (`@theme`), next-themes, lucide-react, Prisma 7, Vitest 4 + Testing Library.

---

## Extracted design facts (public MCP directory source, 2026-06-23)

Theme mechanism: **next-themes**, `class` strategy on `<html>` (`light`/`dark`), default light. Colors are shadcn **HSL triplets** consumed as `hsl(var(--x))`.

```
            LIGHT (:root)        DARK (.dark)
--background        0 0% 100%          0 0% 2%
--foreground       0 0% 3.9%          0 0% 93%
--card             0 0% 100%          0 0% 5%
--card-foreground  0 0% 3.9%          0 0% 93%
--popover          0 0% 100%          0 0% 5%
--popover-foreground 0 0% 3.9%        0 0% 93%
--primary          0 0% 9%            0 0% 93%
--primary-foreground 0 0% 98%         0 0% 2%
--secondary        0 0% 96.1%         0 0% 10%
--secondary-foreground 0 0% 9%        0 0% 93%
--muted            0 0% 96.1%         0 0% 10%
--muted-foreground 0 0% 45.1%         0 0% 50%
--accent           0 0% 96.1%         0 0% 10%
--accent-foreground 0 0% 9%           0 0% 93%
--destructive      0 84.2% 60.2%      0 62.8% 30.6%
--destructive-foreground 0 0% 98%     0 0% 98%
--border           0 0% 89.8%         0 0% 15%
--input            0 0% 89.8%         0 0% 15%
--ring             0 0% 3.9%          0 0% 50%
--radius           0rem               0rem
```

Fonts: body **Inter** (`--font-sans`); card titles **mono** (site class `font-geist-mono` → we map Tailwind `font-mono` to Geist Mono). Base font-size 16px.

Header: `<header>` sticky top, height ~57px, `background: hsl(var(--background)/0.8)`, `backdrop-blur`, `border-b` 1px `hsl(var(--border))` (neutral-200 light).

Nav (anchors): logo **ToolPlane**→`/`; **Sell Skills**→`/sell`; Hub CTA **"Power Your Agents / Connect"**→`/hub`. Plus a theme toggle button + (search — deferred to P1c).

Home sections (top→bottom): hero `<h1>` "Find The Best MCP Servers - Agent Skills - MCP Clients - Agent Tools"; then `Official MCP Servers`, `Featured MCP Servers`, `Top MCP Servers`, `Latest MCP Servers` (6 server cards each); `MCP Clients` (6 client cards); `Top Agent Skills` (6 skill cards); `Frequently Asked Questions` (8 Q&A — **deferred to P1c**, answer copy not yet scraped).

Card markup (server example):
```html
<a class="group block" href="/server/firecrawl">
  <div class="relative h-full rounded-lg border border-border bg-card transition-colors duration-200 hover:border-foreground/20 hover:bg-accent/50">
    <div class="p-5">
      <div class="mb-3 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2.5">
          <img width="20" height="20" class="shrink-0 rounded-full object-cover opacity-50 grayscale transition-all duration-200 group-hover:opacity-100 group-hover:grayscale-0" src="{iconUrl}">
          <!-- author -->
        </div>
        <!-- stat (stars / score) -->
      </div>
      <h3 class="line-clamp-1 font-mono text-base font-semibold text-foreground">Firecrawl</h3>
      <p class="mb-4 line-clamp-2 text-sm leading-relaxed text-muted-foreground">Empowers LLMs with…</p>
    </div>
  </div>
</a>
```
Detail routes (singular): `/server/{slug}`, `/client/{slug}`, skills under `/tools/skills`. Cards link to `/server/{slug}` and `/client/{slug}`; skills link to `/tools/skills/{slug}` (confirm in P1c).

Footer: 4 columns.
- **MCP**: MCP Search→`/search`, MCP Servers→`/server`, MCP Clients→`/client`, Agent Skills→`/tools/skills`, ToolPlane Hub→`/hub`
- **Browse**: Categories→`/categories`, What is an MCP server?→`/what-is-an-mcp-server`, Model Context Protocol→`https://modelcontextprotocol.io`
- **Rankings**: Top MCPs Today→`/daily`, Top Agent Skills Today→`/daily/skills`, Top 100 Agent Skills→`/tools/skills/leaderboard`, Top 100 MCP Servers→`/leaderboards`
- **About**: News→`/news`, Submit→`/submit`, Contact→`mailto:support@public MCP directory source`, Privacy→`/privacy`, Terms→`/terms`

---

## File map

- `src/app/globals.css` — design tokens (`:root` + `.dark`), `@theme inline` mapping, radius chain, fonts. (rewrite)
- `src/app/layout.tsx` — Inter + Geist_Mono fonts, `suppressHydrationWarning`, metadata, `<ThemeProvider>` + `<Header/>` `<Footer/>` shell. (rewrite)
- `src/components/theme/ThemeProvider.tsx` — next-themes provider (client).
- `src/components/theme/ThemeToggle.tsx` — Sun/Moon toggle (client).
- `src/components/layout/Header.tsx` — sticky header + nav + toggle.
- `src/components/layout/Footer.tsx` — 4-column footer.
- `src/components/cards/EntityCard.tsx` — shared presentational card.
- `src/components/cards/ServerCard.tsx` / `ClientCard.tsx` / `SkillCard.tsx` — entity→EntityCard wrappers.
- `src/components/home/HomeView.tsx` — hero + section grids (presentational).
- `src/lib/queries/home.ts` — `getHomeSections()`.
- `src/app/page.tsx` — async server component: fetch → `<HomeView>`.
- Tests under `tests/unit/**` (jsdom) and `tests/integration/home.test.ts` (`// @vitest-environment node`).

---

## Tasks

### Task 1 — deps + design tokens
- [ ] `pnpm add next-themes lucide-react`
- [ ] Rewrite `globals.css`: `@import "tailwindcss";` then `:root{ --background:0 0% 100%; … --radius:0rem }`, `.dark{ … }`, radius chain (`--radius-sm:calc(var(--radius)-4px)` … `--radius-lg:var(--radius)`), and `@theme inline{ --color-background:hsl(var(--background)); … --color-border:hsl(var(--border)); --color-card:hsl(var(--card)); --color-muted-foreground:hsl(var(--muted-foreground)); … --radius-lg:var(--radius-lg); --font-sans:var(--font-inter); --font-mono:var(--font-geist-mono); }`. `body{ background:hsl(var(--background)); color:hsl(var(--foreground)); font-family:var(--font-sans) }`.
- [ ] Verify: `pnpm exec tsc --noEmit` clean; `pnpm dev` boots and `/` renders without CSS errors.
- [ ] Commit `feat: add shadcn design tokens and fonts`.

### Task 2 — ThemeProvider + ThemeToggle (TDD)
- [ ] Test `tests/unit/theme-toggle.test.tsx`: render `<ThemeToggle>` inside a mocked next-themes context; assert it shows a toggle button (accessible name "Toggle theme"); clicking calls `setTheme`.
- [ ] Implement `ThemeProvider` (`'use client'`, wraps `next-themes` `ThemeProvider` with `attribute="class" defaultTheme="system" enableSystem`).
- [ ] Implement `ThemeToggle` (`'use client'`, `useTheme()`, Sun/Moon from lucide, `aria-label="Toggle theme"`).
- [ ] Verify tests pass; commit `feat: add theme provider and toggle`.

### Task 3 — Header (TDD)
- [ ] Test `tests/unit/header.test.tsx`: renders logo link to `/` with text ToolPlane; nav links `Sell Skills`→`/sell`, Hub→`/hub`; contains a theme toggle (`aria-label="Toggle theme"`).
- [ ] Implement `Header` (`<header class="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur">`, inner `mx-auto flex h-[57px] max-w-screen-xl items-center justify-between px-4`).
- [ ] Verify; commit `feat: add site header`.

### Task 4 — Footer (TDD)
- [ ] Test `tests/unit/footer.test.tsx`: renders column headings MCP/Browse/Rankings/About and key links (`/server`, `/categories`, `/leaderboards`, `/privacy`).
- [ ] Implement `Footer` from the captured column/link sets.
- [ ] Verify; commit `feat: add site footer`.

### Task 5 — shell wiring
- [ ] Rewrite `layout.tsx`: load `Inter({variable:'--font-inter'})` + `Geist_Mono({variable:'--font-geist-mono'})`; `<html lang="en" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable}`}>`; `<body class="min-h-dvh bg-background text-foreground font-sans antialiased">`; wrap `<ThemeProvider><div class="flex min-h-dvh flex-col"><Header/><main class="flex-1">{children}</main><Footer/></div></ThemeProvider>`; metadata title "Discover Top MCP Servers | ToolPlane".
- [ ] Verify `pnpm dev`: header + footer visible on `/`, theme toggle flips `<html class>`.
- [ ] Commit `feat: wire global shell into layout`.

### Task 6 — EntityCard + Server/Client/Skill wrappers (TDD)
- [ ] Test `tests/unit/entity-card.test.tsx`: `<ServerCard server={…}>` renders name, 2-line description, author, link `href="/server/{slug}"`, stat (stars). `<SkillCard>` links `/tools/skills/{slug}` and shows score. `<ClientCard>` links `/client/{slug}`.
- [ ] Implement `EntityCard` (props `{href,name,author,description,iconUrl,stat?}`) using captured markup. Wrappers map entity fields.
- [ ] Verify; commit `feat: add entity cards`.

### Task 7 — getHomeSections (integration TDD)
- [ ] Test `tests/integration/home.test.ts` (`// @vitest-environment node`): seed servers (official/featured/varied stars/createdAt), clients, skills; assert each section length ≤ 6 and ordering (official by stars among `isOfficial`, featured among `isFeatured`, top by stars, latest by createdAt desc, clients by stars, topSkills by score). Clean up seeded rows in `afterAll`.
- [ ] Implement `getHomeSections()` running the six queries (Promise.all).
- [ ] Verify; commit `feat: add home sections query`.

### Task 8 — HomeView + page (TDD)
- [ ] Test `tests/unit/home-view.test.tsx`: `<HomeView>` with mock section data renders the section headings and one card per section.
- [ ] Implement `HomeView` (hero `<h1>` + search box linking `/search`; then sections rendered as `<section>` with `<h2>` heading + responsive grid `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` of cards).
- [ ] Implement `page.tsx`: `export default async function Home(){ const d = await getHomeSections(); return <HomeView {...d}/> }`.
- [ ] Verify full suite (`pnpm test`) + `tsc` clean; `pnpm dev` smoke; commit `feat: add home page`.

---

## Non-goals (deferred to P1c)
FAQ section (needs scraped answer copy), `/search` page, MegaMenu/mobile nav drawer, hero subtitle/exact spacing pixel-diff pass, real `@playwright/test` e2e runner, full catalog scrape + real-markup parser selectors, detail pages.

## Self-review
- Spec coverage: tokens (T1), theme (T2), header (T3), footer (T4), shell (T5), cards (T6), query (T7), home (T8) — all P1b spec items covered; FAQ/search explicitly deferred.
- Type consistency: `getHomeSections()` returns keys `officialServers/featuredServers/topServers/latestServers/clients/topSkills`; `HomeView` props and `page.tsx` spread use the same keys.
- No placeholders: token values and link sets are concrete (from live extraction); component code written at implementation time in-session.
