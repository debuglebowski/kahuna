#!/bin/sh
# Allting container entrypoint.
#
#   serve     (default) run the HTTP server
#   migrate            apply migrations, bootstrap the initial admin, then exit
#   bootstrap          initial admin only (migrations already applied)
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
    exec bun /srv/allting/packages/app/server/index.ts
    ;;
  migrate)
    # CWD matters: drizzle-kit resolves the config's relative `schema`/`out`
    # against process.cwd(). The config asserts it can see the journal from here,
    # so a wrong directory fails loudly instead of applying nothing.
    echo "==> Applying migrations"
    cd /srv/allting/packages/app && bunx drizzle-kit migrate
    echo "==> Migrations complete"
    # Bootstrap rides along here rather than in `serve` for the same two reasons
    # migrations do: this step is single-instance, so N replicas cannot race it,
    # and a failure fails its own command instead of being buried in startup
    # logs. It is a no-op unless the deployment is empty AND the INITIAL_ADMIN_*
    # vars are set, so running it on every deploy is safe.
    echo "==> Bootstrapping initial admin"
    bun scripts/bootstrap.ts
    ;;
  bootstrap)
    echo "==> Bootstrapping initial admin"
    cd /srv/allting/packages/app && bun scripts/bootstrap.ts
    ;;
  *)
    exec "$@"
    ;;
esac
