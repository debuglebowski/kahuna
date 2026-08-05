import "../server/env"

import { bootstrapInitialAdmin, isEmptyDeployment } from "../server/bootstrap"

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
} else if (await isEmptyDeployment()) {
  // The one combination that leaves a deployment unusable. Sign-up is closed, so
  // "no INITIAL_ADMIN_* and no accounts" means the deploy just went green with
  // nobody able to reach the app — which the neutral "skipped" line below reads
  // exactly like. Say so instead of leaving it to be discovered at the sign-in
  // screen.
  //
  // Still exit 0: the entrypoint runs this under `set -e`, and an operator who
  // provisions by hand with scripts/create-admin.ts is in this state on purpose.
  // Failing here would abort their deploy over a supported path.
  console.warn("bootstrap: WARNING — this deployment has no accounts and no way to sign in.")
  console.warn("           Self-serve sign-up is closed, so nobody can reach the app yet.")
  console.warn("           Set INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD and re-run,")
  console.warn("           or provision by hand with scripts/create-admin.ts.")
} else {
  console.log("bootstrap: skipped — INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD not set.")
}

process.exit(0)
