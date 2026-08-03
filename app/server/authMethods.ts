import { eq, sql } from "drizzle-orm"
import { member, orgAuthSettings, organization, ssoProvider, user } from "#db"
import { db } from "./db"

/**
 * Which sign-in methods an org accepts, and the lookups the sign-in gates in
 * `auth.ts` need to enforce them.
 *
 * This lives apart from both `auth.ts` and `sso.ts` on purpose: `auth.ts` needs
 * it to build the BetterAuth instance, and `sso.ts` needs `auth.api` — so the
 * shared reads have to sit in a module that imports NEITHER, or the three form
 * a cycle. Nothing here reaches for a session; callers supply ids.
 */

export interface AuthMethods {
  readonly passwordEnabled: boolean
  readonly ssoEnabled: boolean
}

/** Password on, SSO off — what an org with no settings row gets. Existing orgs
 *  therefore need no backfill, and a deployment that never opens the settings
 *  page behaves exactly as it did before SSO existed. */
export const DEFAULT_METHODS: AuthMethods = { passwordEnabled: true, ssoEnabled: false }

export const readAuthMethods = async (orgId: string): Promise<AuthMethods> => {
  const [row] = await db
    .select({
      passwordEnabled: orgAuthSettings.passwordEnabled,
      ssoEnabled: orgAuthSettings.ssoEnabled,
    })
    .from(orgAuthSettings)
    .where(eq(orgAuthSettings.orgId, orgId))
    .limit(1)
  return row ?? DEFAULT_METHODS
}

export const writeAuthMethods = async (orgId: string, methods: AuthMethods): Promise<void> => {
  await db
    .insert(orgAuthSettings)
    .values({ orgId, ...methods })
    .onConflictDoUpdate({ target: orgAuthSettings.orgId, set: methods })
}

/**
 * Does `domain` match a provider's `domain` column? Better-auth stores a bare
 * domain OR a comma-separated list, so a plain equality check would silently
 * fail every multi-domain provider. Case-insensitive; empty entries ignored.
 */
export const domainMatches = (domain: string, providerDomains: string): boolean => {
  const want = domain.trim().toLowerCase()
  if (!want) return false
  return providerDomains
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .includes(want)
}

/** The domain part of an email address, lowercased ("" when malformed). */
export const emailDomain = (email: string): string => email.trim().toLowerCase().split("@")[1] ?? ""

/**
 * May this email address sign in with a password?
 *
 * The rule, in order:
 *  - unknown address, or one with no org memberships → yes. Not our call to
 *    make, and rejecting here would turn the gate into an account oracle for
 *    addresses that don't exist.
 *  - owner of ANY org → yes, ALWAYS. This is the break-glass. An owner who
 *    misconfigures their IdP (wrong issuer, expired secret, IdP outage) has to
 *    retain a way back in, or a self-hosted deployment bricks itself with no
 *    remedy short of DB access.
 *  - otherwise → yes only if at least one of their orgs still allows password.
 *    A member of two orgs where only one is SSO-only is not locked out of the
 *    other one.
 *
 * KNOWN TRADE-OFF: rejecting in a `before` hook — i.e. before the password is
 * checked — tells an unauthenticated caller that the address exists and is
 * SSO-only. The alternative (reject after verifying credentials) means minting
 * a session and then unwinding it. For a deployment where addresses are company
 * addresses and the member list is not secret, the leak is worth the guarantee
 * that no session is ever created for a blocked sign-in.
 */
export const passwordSignInAllowed = async (email: string): Promise<boolean> => {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return true

  const rows = await db
    .select({
      role: member.role,
      // LEFT JOIN: an org with no settings row falls back to the default rather
      // than dropping out of the result set (which would read as "no orgs").
      passwordEnabled: sql<boolean>`coalesce(${orgAuthSettings.passwordEnabled}, true)`,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(orgAuthSettings, eq(orgAuthSettings.orgId, member.organizationId))
    .where(eq(sql`lower(${user.email})`, normalized))

  if (rows.length === 0) return true
  if (rows.some((r) => r.role === "owner")) return true
  return rows.some((r) => r.passwordEnabled)
}

export interface SignInProvider {
  readonly providerId: string
  readonly organizationId: string | null
}

/**
 * Resolve which provider a `/sign-in/sso` body would land on, so the gate can
 * check that org's toggle BEFORE better-auth redirects to the IdP.
 *
 * Mirrors better-auth's own precedence (providerId → domain → email domain →
 * organization slug). Returning null means "couldn't tell" — the gate then lets
 * the request through and lets better-auth produce its own error, rather than
 * inventing one.
 */
export const resolveSignInProvider = async (body: {
  providerId?: unknown
  domain?: unknown
  email?: unknown
  organizationSlug?: unknown
}): Promise<SignInProvider | null> => {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

  const providerId = str(body.providerId)
  if (providerId) {
    const [row] = await db
      .select({ providerId: ssoProvider.providerId, organizationId: ssoProvider.organizationId })
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, providerId))
      .limit(1)
    return row ?? null
  }

  const slug = str(body.organizationSlug)
  if (slug) {
    const [row] = await db
      .select({ providerId: ssoProvider.providerId, organizationId: ssoProvider.organizationId })
      .from(ssoProvider)
      .innerJoin(organization, eq(organization.id, ssoProvider.organizationId))
      .where(eq(organization.slug, slug))
      .limit(1)
    return row ?? null
  }

  // Domain, or the domain half of an email. Both need `domainMatches` rather
  // than a SQL equality, because the column may hold a comma-separated list.
  const domain = str(body.domain).toLowerCase() || emailDomain(str(body.email))
  if (!domain) return null
  const rows = await db
    .select({
      providerId: ssoProvider.providerId,
      organizationId: ssoProvider.organizationId,
      domain: ssoProvider.domain,
    })
    .from(ssoProvider)
  return rows.find((r) => domainMatches(domain, r.domain)) ?? null
}
