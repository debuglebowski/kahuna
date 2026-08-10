import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { eq } from "drizzle-orm"
import { account, organization, user } from "#db"
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

/**
 * Unique, URL-safe org slug. Mirrors `src/lib/org.ts` deliberately rather than
 * importing it: that module lives in the client tree, and every server -> src
 * import has to be added to the Dockerfile by hand or the image cannot boot
 * (see the COPY block there). Not worth a new cross-tree edge for 6 lines.
 *
 * BetterAuth requires a non-empty unique slug; we never surface it in the UI.
 */
export const makeOrgSlug = (name: string): string => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${base || "org"}-${Math.random().toString(36).slice(2, 7)}`
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
 * org gets seeded with the Allting concepts (see auth.ts).
 *
 * ONE ORG PER DEPLOYMENT. This refuses to create a second, which is what makes
 * that a real invariant rather than a convention: every production path to a new
 * org runs through here (bootstrap + create-admin), because the HTTP endpoint is
 * closed to sessions and unreachable without one.
 *
 * The check lives here and NOT in the database on purpose. A singleton index on
 * `bauth_organization` would express it more strongly, but the test suite
 * isolates by giving each file its own org in one shared database — so a DB
 * constraint would force a rewrite of that isolation model to enforce something
 * production already cannot violate. Tests call `auth.api.createOrganization`
 * directly and so bypass this deliberately.
 */
export const createOrgDirect = async (input: {
  readonly userId: string
  readonly name: string
  readonly slug: string
}): Promise<{ readonly id: string }> => {
  const [existing] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .limit(1)
  if (existing) {
    throw new Error(
      `this deployment already has an organization ("${existing.name}") — one org per deployment`,
    )
  }

  const org = await auth.api.createOrganization({
    body: { name: input.name, slug: input.slug, userId: input.userId },
  })
  if (!org) throw new Error(`failed to create organization "${input.name}"`)
  return { id: org.id }
}
