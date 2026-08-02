import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { eq } from "drizzle-orm"
import { account, user } from "#db"
import { auth } from "./auth"
import { db } from "./db"

/**
 * Server-side account + org provisioning, for when the public sign-up route is
 * closed (`emailAndPassword.disableSignUp`, see auth.ts).
 *
 * WHY THIS EXISTS: `disableSignUp` is checked INSIDE the route handler
 * (better-auth's `api/routes/sign-up.mjs`), so it rejects `auth.api.signUpEmail`
 * too — not just HTTP. Every path that legitimately needs to mint an account
 * (the operator CLIs, the test suite, the verify drivers) therefore has to write
 * the rows itself rather than go through the endpoint.
 *
 * It writes the same two rows sign-up would: a `bauth_user`, plus a `credential`
 * `bauth_account` holding a BetterAuth-format password hash. That is exactly the
 * shape `scripts/reset-password.ts` already writes, so this depends on the
 * documented hash helper and our own schema — not on BetterAuth internals.
 *
 * Sign-IN is unaffected by `disableSignUp`, so an account created here can be
 * used immediately, including through the app's sign-in form.
 */
export interface CreateUserInput {
  readonly email: string
  readonly password: string
  readonly name?: string
}

export interface CreatedUser {
  readonly userId: string
  readonly email: string
  /** False when the email already existed and the row was reused (idempotent). */
  readonly created: boolean
}

/**
 * Create a sign-in-ready email+password account. Idempotent on email: an
 * existing user is returned untouched (its password is NOT reset — use
 * `scripts/reset-password.ts` for that), so repeated verify-script runs and
 * re-runs of the operator CLI are safe.
 */
export const createUserDirect = async (input: CreateUserInput): Promise<CreatedUser> => {
  const email = input.email.trim().toLowerCase()
  if (!email || !input.password) throw new Error("email and password are required")

  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
  if (existing) return { userId: existing.id, email, created: false }

  const userId = randomUUID()
  const now = new Date()
  await db.insert(user).values({
    id: userId,
    name: input.name?.trim() || email,
    email,
    // No mail provider is wired up, so there is no verification round-trip to
    // complete. Marking it verified keeps `requireEmailVerification` (if it is
    // ever switched on) from locking out accounts provisioned this way.
    emailVerified: true,
  })
  await db.insert(account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(input.password),
    updatedAt: now,
  })
  return { userId, email, created: true }
}

/**
 * Create an organization owned by `userId`, bypassing the
 * `allowUserToCreateOrganization: false` guard.
 *
 * Passing `userId` with NO `headers` is better-auth's own "system action" path
 * (`plugins/organization/routes/crud-org.mjs`: `isSystemAction = !session &&
 * ctx.body.userId`), which skips that check. Going through the endpoint rather
 * than inserting rows matters: it still fires `afterCreateOrganization`, so the
 * org gets seeded with the Kingsmaker concepts (see auth.ts).
 */
export const createOrgDirect = async (input: {
  readonly userId: string
  readonly name: string
  readonly slug: string
}): Promise<{ readonly id: string }> => {
  const org = await auth.api.createOrganization({
    body: { name: input.name, slug: input.slug, userId: input.userId },
  })
  if (!org) throw new Error(`failed to create organization "${input.name}"`)
  return { id: org.id }
}
