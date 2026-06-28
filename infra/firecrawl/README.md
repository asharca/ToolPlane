# Self-hosted Firecrawl (keyless) for MCP Station

Runs the **real Firecrawl engine locally/on your server with no API key**, so the
`Firecrawl` catalog entry can be deployed for real (its `firecrawl-mcp` runs in
our sandbox and talks to this engine).

## What it is

`docker-compose.yml` brings up the Firecrawl self-host stack from the prebuilt
`ghcr.io/firecrawl/*` images (no source build):

| service | image | role |
|---|---|---|
| `api` (`firecrawl-api`) | `ghcr.io/firecrawl/firecrawl` | API + worker + extract (one harness process group) on :3002 |
| `playwright-service` | `ghcr.io/firecrawl/playwright-service` | headless browser rendering |
| `nuq-postgres` | `ghcr.io/firecrawl/nuq-postgres` | job queue backend |
| `redis` | `redis:alpine` | cache / rate limit |
| `rabbitmq` | `rabbitmq:3-management` | queue transport |

Keyless because `USE_DB_AUTHENTICATION=false`. The `api` joins the external
`mcp-sandbox` network under the alias **`firecrawl-api`**, the same network MCP
sandbox containers run on, so a `firecrawl-mcp` deployment reaches it at
`http://firecrawl-api:3002`.

Needs **~8 GB RAM** headroom. Self-hosted Firecrawl has **no Fire Engine** (no
anti-bot / IP rotation) — it scrapes via basic fetch + Playwright.

## Bring it up (server or local)

```bash
# the app creates `mcp-sandbox` at startup; create it manually if the app isn't running:
docker network inspect mcp-sandbox >/dev/null 2>&1 || docker network create mcp-sandbox

docker compose -f infra/firecrawl/docker-compose.yml up -d

# smoke test a keyless scrape (give it ~30s to warm up):
curl -s -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://firecrawl.dev","formats":["markdown"]}'
```

## Wire the Firecrawl catalog entry

In the admin console → **MCP Market → Firecrawl → Deploy recipe**:

- **Source:** `npm`
- **Reference:** `firecrawl-mcp`
- **Preset env values:**
  ```
  FIRECRAWL_API_URL=http://firecrawl-api:3002
  FIRECRAWL_API_KEY=self-hosted
  ```
- **Save recipe**, then **Validate**.

> `firecrawl-mcp` demands *some* `FIRECRAWL_API_KEY` even against a self-hosted
> URL ([firecrawl-mcp-server#126](https://github.com/firecrawl/firecrawl-mcp-server/issues/126)),
> so a dummy value is preset — no real key, no cloud. Validation runs the MCP in
> the sandbox against this engine and lists its tools (~26); on success the entry
> becomes deployable in workspaces.

## Gotcha: SSRF guard + odd DNS

Firecrawl blocks targets that resolve to private/reserved IP ranges
(`"resolves to a private/internal address"`). If your host's DNS remaps public
domains into a reserved range (some VPN/proxy setups map them to `198.18.0.0/15`),
every scrape is blocked even though egress works. Use a normal server resolver.

## Tear down

```bash
docker compose -f infra/firecrawl/docker-compose.yml down
```
