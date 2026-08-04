import { eq } from "drizzle-orm"
import { organization, ssoProvider } from "#db"
import { auth } from "./auth"
import { type AuthMethods, readAuthMethods, writeAuthMethods } from "./authMethods"
import { db } from "./db"
import { resolveAdmin, resolveOwner } from "./session"

/**
 * Org-level authentication configuration: the OIDC provider, and which sign-in
 * methods the org accepts.
 *
 * Shaped like the integration connectors (`posthog.ts`, `slack.ts`) — one row per
 * org, a handful of request handlers, a route block in `router.ts` — with one
 * deliberate difference: WRITES REQUIRE `owner`, not `admin`. `resolveAdmin`
 * guards org-wide *integrations*; this guards who can get into the org at all.
 * An admin able to re-point the org at an IdP they control would be able to mint
 * themselves members. Reads stay at `admin` so the settings page renders
 * read-only for them.
 *
 * SECRET AT REST — ACCEPTED RISK. `bauth_sso_provider.oidc_config` holds the
 * IdP client secret as plain JSON, unlike every other credential here
 * (`integrations/crypto.ts` encrypts those). The plugin reads that column
 * directly on every sign-in, so encrypting it would mean owning the plugin's
 * read path. Mitigations instead: the secret is never returned to a client (see
 * `providerPayload`), and it is write-only in the UI.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

/**
 * The provider id, derived from the ORG ID and nothing else.
 *
 * It has to be globally unique (the plugin enforces that) and it must never
 * change: it is baked into the redirect URI registered at the IdP, so a
 * different id silently breaks every future sign-in. The org SLUG would be the
 * friendlier choice and is exactly wrong — it is editable on the Organization
 * page. The plugin also rejects ids that collide with a social provider or a
 * built-in like `credential`; the `org-` prefix keeps us clear of those.
 */
const providerIdFor = (orgId: string): string => `org-${orgId}`

/** Where the IdP must send the user back. Read from better-auth's own resolved
 *  baseURL (which already includes the `/api/auth` basePath) rather than
 *  reassembled from env, so it cannot drift from what the plugin actually uses. */
const callbackUrlFor = async (orgId: string): Promise<string> => {
  const ctx = await auth.$context
  return `${ctx.baseURL}/sso/callback/${providerIdFor(orgId)}`
}

interface ProviderPayload {
  readonly providerId: string
  readonly issuer: string
  readonly domain: string
  readonly clientId: string
  /** Whether a secret is stored. The secret itself is NEVER serialized. */
  readonly hasSecret: boolean
}

const providerPayload = async (orgId: string): Promise<ProviderPayload | null> => {
  const [row] = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, orgId))
    .limit(1)
  if (!row) return null

  // Written by the plugin, so treat it as opaque: a parse failure must degrade
  // to "configured but unreadable" rather than 500 the settings page.
  let clientId = ""
  let hasSecret = false
  try {
    const cfg = JSON.parse(row.oidcConfig ?? "{}") as {
      clientId?: unknown
      clientSecret?: unknown
    }
    clientId = typeof cfg.clientId === "string" ? cfg.clientId : ""
    hasSecret = typeof cfg.clientSecret === "string" && cfg.clientSecret.length > 0
  } catch {
    /* leave the defaults */
  }

  return { providerId: row.providerId, issuer: row.issuer, domain: row.domain, clientId, hasSecret }
}

/**
 * GET /api/auth-config/public — which sign-in methods to render. NO SESSION:
 * this is read by the sign-in page, before anyone is authenticated.
 *
 * Safe to expose because it is a property of the DEPLOYMENT, not of a person.
 * `createOrgDirect` enforces one org per deployment (provision.ts), so "which
 * org?" has a single answer that does not depend on who is asking — nothing here
 * is keyed on an email address, so it cannot be used to probe whether an account
 * exists. Booleans only: the issuer, client id and domains stay behind the
 * admin-gated endpoint above.
 *
 * The permissive fallback (both methods) is deliberate for 0 orgs — a
 * pre-bootstrap deployment — and for the 2+ case that only tests produce, where
 * the visitor's org is genuinely unknowable. Rendering a method the org rejects
 * costs a clear error; hiding one it accepts locks people out of the UI.
 */
export const publicAuthMethods = async (): Promise<Response> => {
  const orgs = await db.select({ id: organization.id }).from(organization).limit(2)
  if (orgs.length !== 1 || !orgs[0]) return json({ passwordEnabled: true, ssoEnabled: true })

  const methods = await readAuthMethods(orgs[0].id)
  // Guard the UI against a half-configured org: SSO on with the provider row
  // since deleted would render an SSO button that cannot resolve a provider.
  const provider = methods.ssoEnabled ? await providerPayload(orgs[0].id) : null
  return json({
    passwordEnabled: methods.passwordEnabled,
    ssoEnabled: methods.ssoEnabled && Boolean(provider),
  })
}

/** GET /api/auth-config/sso — the whole settings page in one call. Admin-readable. */
export const authConfigStatus = async (req: Request): Promise<Response> => {
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  return json({
    methods: await readAuthMethods(org.orgId),
    provider: await providerPayload(org.orgId),
    callbackUrl: await callbackUrlFor(org.orgId),
    // The page hides every control for a non-owner rather than letting them
    // submit and collect a 403.
    canEdit: org.role === "owner",
  })
}

/**
 * POST /api/auth-config/sso — register or replace the org's OIDC provider.
 *
 * Replace, never append: `sso_provider_org_uq` allows one row per org, and the
 * id is deterministic, so an edit is a delete followed by a register. That also
 * keeps the callback URL stable across edits — the operator pastes it into the
 * IdP once.
 *
 * Everything past `clientId`/`clientSecret` (authorization/token/userinfo/JWKS
 * endpoints) is discovered by the plugin from `{issuer}/.well-known/
 * openid-configuration`, so the form asks for four fields, not twelve.
 */
export const saveSsoProvider = async (req: Request): Promise<Response> => {
  const org = await resolveOwner(req)
  if (!org.ok) return json({ error: org.code }, org.status)

  const body = (await req.json().catch(() => null)) as {
    issuer?: string
    domain?: string
    clientId?: string
    clientSecret?: string
  } | null

  const issuer = body?.issuer?.trim() ?? ""
  const domain = body?.domain?.trim().toLowerCase() ?? ""
  const clientId = body?.clientId?.trim() ?? ""
  const clientSecret = body?.clientSecret ?? ""
  if (!issuer || !domain || !clientId || !clientSecret) {
    return json({ error: "MISSING_FIELDS" }, 400)
  }

  // The issuer is fetched server-side for discovery, so an attacker-supplied
  // scheme is an SSRF primitive. Require https and a real host.
  let parsed: URL
  try {
    parsed = new URL(issuer)
  } catch {
    return json({ error: "INVALID_ISSUER" }, 400)
  }
  if (parsed.protocol !== "https:") return json({ error: "ISSUER_MUST_BE_HTTPS" }, 400)

  // Bare domains only — `@` or a scheme here means the operator pasted an email
  // or a URL, and the value would silently never match anything.
  const domains = domain
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
  if (domains.length === 0 || domains.some((d) => d.includes("@") || d.includes("/"))) {
    return json({ error: "INVALID_DOMAIN" }, 400)
  }

  const providerId = providerIdFor(org.orgId)
  // Idempotent: drop any previous row for this org first. Deleting by the
  // deterministic id also cleans up a row whose organizationId was somehow lost.
  await auth.api
    .deleteSSOProvider({ body: { providerId }, headers: req.headers })
    .catch(() => undefined)

  try {
    await auth.api.registerSSOProvider({
      body: {
        providerId,
        issuer,
        domain: domains.join(","),
        organizationId: org.orgId,
        oidcConfig: { clientId, clientSecret },
      },
      headers: req.headers,
    })
  } catch (e) {
    // Discovery failures (unreachable issuer, no well-known document) surface
    // here. Pass the message through — the operator is the one who can fix it.
    return json({ error: "REGISTER_FAILED", message: String((e as Error).message ?? e) }, 400)
  }

  return json({ ok: true, provider: await providerPayload(org.orgId) })
}

/** DELETE /api/auth-config/sso — remove the provider and force SSO off, so the
 *  org can never be left requiring a provider that no longer exists. */
export const deleteSsoProvider = async (req: Request): Promise<Response> => {
  const org = await resolveOwner(req)
  if (!org.ok) return json({ error: org.code }, org.status)

  const methods = await readAuthMethods(org.orgId)
  await writeAuthMethods(org.orgId, { passwordEnabled: true, ssoEnabled: false })
  await auth.api
    .deleteSSOProvider({ body: { providerId: providerIdFor(org.orgId) }, headers: req.headers })
    .catch(() => undefined)

  // Password is forced back on above: removing the only other way in while
  // password sign-in is off would lock every non-owner out.
  return json({ ok: true, passwordReenabled: !methods.passwordEnabled })
}

/**
 * POST /api/auth-config/methods — set the sign-in method toggles.
 *
 * Two invariants, both enforced here rather than in the DB (a CHECK constraint
 * can express the first but not the second):
 *   - never both off, or nobody can sign in;
 *   - SSO cannot be on without a registered provider, or "SSO only" would mean
 *     "no way in at all".
 * Note this is still not sufficient on its own to prevent lockout — the IdP can
 * break after the fact — which is why owners keep password access
 * unconditionally (see `passwordSignInAllowed`).
 */
export const updateAuthMethods = async (req: Request): Promise<Response> => {
  const org = await resolveOwner(req)
  if (!org.ok) return json({ error: org.code }, org.status)

  const body = (await req.json().catch(() => null)) as {
    passwordEnabled?: unknown
    ssoEnabled?: unknown
  } | null
  if (typeof body?.passwordEnabled !== "boolean" || typeof body?.ssoEnabled !== "boolean") {
    return json({ error: "MISSING_FIELDS" }, 400)
  }
  const methods: AuthMethods = {
    passwordEnabled: body.passwordEnabled,
    ssoEnabled: body.ssoEnabled,
  }

  if (!methods.passwordEnabled && !methods.ssoEnabled) {
    return json({ error: "NO_SIGN_IN_METHOD" }, 400)
  }
  if (methods.ssoEnabled && !(await providerPayload(org.orgId))) {
    return json({ error: "NO_SSO_PROVIDER" }, 400)
  }

  await writeAuthMethods(org.orgId, methods)
  return json({ ok: true, methods })
}
