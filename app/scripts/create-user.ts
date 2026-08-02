import "../server/env"

import { createUserDirect } from "../server/provision"

/**
 * CLI: `bun scripts/create-user.ts <email> <password> [name]` — provision an
 * account when self-serve sign-up is closed (see `emailAndPassword.disableSignUp`
 * in server/auth.ts).
 *
 * This IS the invite mechanism. There is no mail provider wired up and the
 * `invitation` table is unused, so the flow is: an operator runs this once per
 * person, then an admin adds them to an org by email in Settings → Members
 * (`POST /api/org/members`, which requires the account to already exist).
 *
 * Idempotent on email — re-running reports the existing user and does NOT reset
 * their password. Use `scripts/reset-password.ts` for that.
 *
 * Runs against whatever `DATABASE_URL` resolves to (root `.env` in dev) — point
 * it at the intended DB before running.
 */
const [email, password, name] = process.argv.slice(2)
if (!email || !password) {
  console.error("usage: bun scripts/create-user.ts <email> <password> [name]")
  process.exit(1)
}

const result = await createUserDirect({ email, password, name })
console.log(
  result.created
    ? `created ${result.email} (${result.userId}) — an admin can now add them to an org by email`
    : `${result.email} already exists (${result.userId}) — password left unchanged`,
)

process.exit(0)
