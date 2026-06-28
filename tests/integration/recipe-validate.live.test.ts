// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureSandboxNetwork } from '@/lib/process/supervisor';
import { validateServerRecipe } from '@/lib/admin/recipe-validate';

// Live end-to-end probe — spins a REAL container, so it needs docker and is slow
// (image pull + package fetch). Skipped by default; run on demand with:
//   SMOKE_DOCKER=1 pnpm vitest run tests/integration/recipe-validate.live.test.ts
const RUN = process.env.SMOKE_DOCKER === '1';

(RUN ? describe : describe.skip)('validateServerRecipe (live docker)', () => {
  beforeAll(async () => {
    await ensureSandboxNetwork();
  }, 30_000);

  it('runs a real keyless MCP package and reads its tools', async () => {
    const r = await validateServerRecipe({
      source: 'npm',
      ref: '@modelcontextprotocol/server-everything',
      env: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.toolCount).toBeGreaterThan(0);
      console.log(`tools (${r.toolCount}): ${r.tools.join(', ')}`);
    } else {
      console.error('validation failed:', r.error);
    }
  }, 120_000);

  // Requires the self-hosted Firecrawl stack on the mcp-sandbox network:
  //   docker compose -f infra/firecrawl/docker-compose.yml up -d
  it('validates firecrawl-mcp against the self-hosted Firecrawl api', async () => {
    const r = await validateServerRecipe({
      source: 'npm',
      ref: 'firecrawl-mcp',
      env: [],
      envValues: {
        FIRECRAWL_API_URL: 'http://firecrawl-api:3002',
        FIRECRAWL_API_KEY: 'self-hosted',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.toolCount).toBeGreaterThan(0);
      process.stdout.write(`\nFIRECRAWL_TOOLS count=${r.toolCount} names=${r.tools.join(',')}\n`);
    } else {
      process.stdout.write(`\nFIRECRAWL_FAIL ${r.error}\n`);
    }
  }, 120_000);
});
