#!/bin/sh
# Kingsmaker container entrypoint.
#
#   serve     (default) run the HTTP server
#   migrate            apply migrations, then exit
#   <anything else>    exec'd verbatim (e.g. `sh`, `bun scripts/...`)
#
# Migration is a SEPARATE command, not part of `serve`. Two reasons:
#   - Concurrency: N replicas starting at once would race the same DDL.
#   - Visibility: a failed migrate must fail its own command loudly rather than
#     be buried in server startup logs. drizzle-kit has a habit of exiting 0
#     having applied nothing (it swallows errors in `generate`, and a missing
#     journal makes `migrate` a silent no-op), so this stays its own step even
#     though there is now only one migration set.
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

case "${1:-serve}" in
  serve)
    exec bun /srv/kingsmaker/app/server/index.ts
    ;;
  migrate)
    # CWD matters: drizzle-kit resolves the config's relative `schema`/`out`
    # against process.cwd(). The config asserts it can see the journal from here,
    # so a wrong directory fails loudly instead of applying nothing.
    echo "==> Applying migrations"
    cd /srv/kingsmaker/app && bunx drizzle-kit migrate
    echo "==> Migrations complete"
    ;;
  *)
    exec "$@"
    ;;
esac
