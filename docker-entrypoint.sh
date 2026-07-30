#!/bin/sh
# Kingsmaker container entrypoint.
#
#   serve     (default) run the HTTP server
#   migrate            apply both migration sets, then exit
#   <anything else>    exec'd verbatim (e.g. `sh`, `bun scripts/...`)
#
# Migration is a SEPARATE command, not part of `serve`. Two reasons:
#   - Concurrency: N replicas starting at once would race the same DDL.
#   - Visibility: a failed migrate must fail its own command loudly rather than
#     be buried in server startup logs. This schema in particular had a failure
#     mode where drizzle-kit exits 0 having applied nothing.
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

case "${1:-serve}" in
  serve)
    exec bun /app/apps/web/server/index.ts
    ;;
  migrate)
    # Engine and auth sets record into separate ledger tables, so order does
    # not matter — but both must run. Neither is optional.
    echo "==> Applying engine migrations (packages/db)"
    cd /app/packages/db && bunx drizzle-kit migrate
    echo "==> Applying auth migrations (apps/web)"
    cd /app/apps/web && bunx drizzle-kit migrate
    echo "==> Migrations complete"
    ;;
  *)
    exec "$@"
    ;;
esac
