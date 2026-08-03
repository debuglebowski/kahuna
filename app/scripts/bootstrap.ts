import "../server/env"

import { bootstrapInitialAdmin } from "../server/bootstrap"

/**
 * CLI: `bun scripts/bootstrap.ts` — create the initial admin + seeded org from
 * INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD, if the deployment is empty.
 *
 * Run it after migrations, on every deploy. It is a no-op once an account
 * exists, so it is safe in an unconditional deploy path — that is the point.
 * The container entrypoint already runs it as part of `migrate`; on a bare host
 * it is `bun run db:migrate && bun run bootstrap`.
 *
 * Runs against whatever `DATABASE_URL` resolves to (root `.env` in dev) — point
 * it at the intended DB before running.
 */
// A bad INITIAL_ADMIN_* value is an operator config error, not a crash: print it
// as one line and exit non-zero. The entrypoint runs under `set -e`, so this
// still aborts the deploy step loudly — just without a Bun stack trace on top of
// a deploy log.
const result = await bootstrapInitialAdmin().catch((err: unknown) => {
  console.error(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

if (result.status === "created") {
  console.log(`initial admin: ${result.email} (${result.userId})`)
  console.log(`org:           ${result.orgName} (${result.orgId}) — seeded`)
  console.log("next:          sign in, add your own account in Settings -> Members,")
  console.log("               promote it to owner, then delete this admin")
} else if (result.reason === "already-provisioned") {
  console.log("bootstrap: skipped — this deployment already has accounts")
} else {
  console.log("bootstrap: skipped — INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD not set.")
  console.log("           Set both and re-run, or provision by hand with scripts/create-admin.ts.")
}

process.exit(0)
