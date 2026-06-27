#!/bin/sh
# Apply pending migrations (retrying until the database is reachable), then start
# Next. On boot, src/instrumentation.ts re-spawns any deployments the DB marks
# as running, so MCP servers come back up automatically after a restart.
set -e

echo "[entrypoint] prisma migrate deploy…"
n=0
until node_modules/.bin/prisma migrate deploy; do
  n=$((n + 1))
  if [ "$n" -ge 15 ]; then
    echo "[entrypoint] migrations failed after $n attempts" >&2
    exit 1
  fi
  echo "[entrypoint] database not ready, retry $n in 2s…"
  sleep 2
done

echo "[entrypoint] starting Next on :3000…"
exec node_modules/.bin/next start
