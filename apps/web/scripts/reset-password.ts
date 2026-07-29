import "../server/env"

import { hashPassword } from "better-auth/crypto"
import { and, eq } from "drizzle-orm"
import * as schema from "../server/auth-schema"
import { db } from "../server/db"

/**
 * CLI: `bun scripts/reset-password.ts <email> <newPassword>` — out-of-band reset
 * of a user's email+password credential. There is no mail provider wired up, so
 * this is the operator path (BetterAuth's `setPassword`/`changePassword` APIs are
 * session-gated and can't be driven from a terminal).
 *
 * Writes the BetterAuth-format hash directly into the `credential` account row.
 * If the user signed up via OAuth only (no `credential` row), one is created.
 * Runs against whatever `DATABASE_URL` resolves to (root `.env` in dev) — point
 * it at the intended DB before running.
 */
const [email, newPassword] = process.argv.slice(2)
if (!email || !newPassword) {
  console.error("usage: bun scripts/reset-password.ts <email> <newPassword>")
  process.exit(1)
}

const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email))
if (!u) {
  console.error(`no user with email: ${email}`)
  process.exit(1)
}

const hash = await hashPassword(newPassword)

const updated = await db
  .update(schema.account)
  .set({ password: hash })
  .where(and(eq(schema.account.userId, u.id), eq(schema.account.providerId, "credential")))
  .returning({ id: schema.account.id })

if (updated.length === 0) {
  // OAuth-only user — no credential row exists yet, so create one.
  await db.insert(schema.account).values({
    id: crypto.randomUUID(),
    accountId: u.id,
    providerId: "credential",
    userId: u.id,
    password: hash,
  })
  console.log(`created credential + set password for ${email} (${u.id})`)
} else {
  console.log(`reset password for ${email} (${u.id}), ${updated.length} account row`)
}

process.exit(0)
