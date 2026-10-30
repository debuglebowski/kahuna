import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { organization } from "better-auth/plugins"
import { asc, eq } from "drizzle-orm"
import * as schema from "#db"
import { auditAuthResponse } from "./authAudit"
import {
  domainMatches,
  emailDomain,
  passwordSignInAllowed,
  readAuthMethods,
  resolveSignInProvider,
} from "./authMethods"
import { CLIENT_IP_HEADER } from "./clientIp"
import { db, pool } from "./db"
import {
  bindDeploymentIdp,
  DEPLOYMENT_IDP_PROVIDER_ID,
  deploymentIdp,
  idTokenHasMfa,
  joinDeploymentOrg,
  SSO_MFA_REQUIRED,
} from "./deploymentIdp"
import { syncMembershipRole } from "./membership"
import { runEngineOrThrow, systemScope } from "./runtime"
import { clientIp, securityEvent, subjectRef } from "./securityLog"
import { seedKahuna } from "./seed/seed"
import { withSsoSecretEncryption } from "./ssoSecretAdapter"

/**
 * Every engine table keyed by `org_id`, in child→parent order (the engine's own
 * FKs constrain the order; org_id itself has no DB-level FK to the BetterAuth
 * organization row, which is exactly why this list must exist).
 *
 * KEEP THIS IN STEP WITH THE SCHEMA. It is asserted against `db/schema.ts` by
 * `auth.test.ts` — a new org-scoped table that isn't listed here leaves rows behind
 * on every org deletion, which is how 28 orphaned access_roles and 22 orphaned
 * dashboards accumulated before the assertion existed.
 */
const ORG_SCOPED_TABLES: ReadonlyArray<string> = [
  // the mention index, first: it references annotations, record versions, fields AND
  // records, so it has to go before any of them
  "mentions",
  // annotation layer (references records/record versions)
  "annotations",
  "annotation_fields",
  "task_statuses",
  "task_priorities",
  "attachments",
  // automations (runs reference automations)
  "automation_runs",
  "automations",
  // access control (rules and assignments reference roles)
  "access_rules",
  "access_role_actors",
  "access_roles",
  "access_policy_versions",
  // per-user sidecars
  "record_view_prefs",
  "member_deactivations",
  "concept_graph_layouts",
  "record_graph_layouts",
  // views + dashboards
  "sidebar_views",
  "dashboards",
  // the core graph (relations → record versions → records → fields → concepts)
  "relations",
  "record_versions",
  "records",
  "fields",
  "labels",
  "events",
  "concepts",
]

/**
 * Delete every engine-owned row for an org — the inverse of the create-time
 * seed. Throws on failure so `beforeDeleteOrganization` aborts the whole
 * deletion. (Blob payloads behind attachments are left in storage — harmless,
 * content-addressed.)
 */
async function purgeOrgEngineData(orgId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    for (const table of ORG_SCOPED_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId])
    }
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

export { ORG_SCOPED_TABLES }

/**
 * BetterAuth owns Tier-0 identity: user / session / account / verification plus
 * the organization plugin's organization / member / invitation tables. The
 * engine FKs to these logically (org_id = organization.id, actor = user.id) but
 * never writes them.
 */
// Origins allowed to make auth requests (CSRF protection). BetterAuth always
// trusts the baseURL origin; these are appended. In dev the browser runs on the
// Vite origin (:5100, pinned via strictPort) while the API is on :3100; dev
// keeps the all-localhost glob so an API_PROXY second stack still works.
// Production trusts only the baseURL plus whatever TRUSTED_ORIGINS lists
// (comma-separated).
const isProd = process.env.NODE_ENV === "production"

/**
 * The session-signing secret. A dev fallback is fine locally, but in production
 * it would mean anyone who has read the source can FORGE a session cookie — so
 * fail the boot instead of starting up insecure. Mirrors the same rule
 * `integrations/crypto.ts` applies to the token-encryption key.
 */
const DEV_SECRET = "dev-secret-change-me"
const authSecret = (): string => {
  const secret = process.env.BETTER_AUTH_SECRET
  if (isProd) {
    if (!secret) throw new Error("BETTER_AUTH_SECRET must be set in production")
    if (secret === DEV_SECRET || secret.length < 32)
      throw new Error("BETTER_AUTH_SECRET is the published placeholder or shorter than 32 chars")
  }
  return secret || DEV_SECRET
}
const envOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
const trustedOrigins = isProd
  ? envOrigins
  : [...envOrigins, "http://localhost:*", "http://127.0.0.1:*"]

export const auth = betterAuth({
  database: withSsoSecretEncryption(drizzleAdapter(db, { provider: "pg", schema })),
  // Sign-IN only. Self-serve sign-up is closed because this deploys internally:
  // accounts are provisioned by an operator (`scripts/create-user.ts`) and then
  // added to an org by an admin. NOTE the check lives INSIDE the route handler,
  // so this rejects `auth.api.signUpEmail` too, not just HTTP — anything that
  // legitimately mints an account goes through `server/provision.ts`.
  emailAndPassword: { enabled: true, disableSignUp: true },
  user: {
    // OFF, deliberately. Two reasons, either sufficient:
    //
    // 1. It never worked. With no mail provider, and neither
    //    `emailVerification.sendVerificationEmail` nor
    //    `changeEmail.updateEmailWithoutVerification` configured, BetterAuth's
    //    handler rejects every call with "Verification email isn't enabled" —
    //    the Settings → Security form 400'd on submit.
    // 2. It shouldn't. Email is the identifier `POST /api/org/members` trusts to
    //    grant org membership, and addresses are never verified anywhere in this
    //    deployment. Letting a session rewrite its own email is therefore a
    //    lateral-movement primitive, not a convenience. Now that accounts are
    //    operator-provisioned (see `disableSignUp` above), the address is
    //    something an operator set on purpose — changing it is their call.
    //
    // To re-enable: wire a mail provider AND `sendChangeEmailConfirmation`, so
    // the new address has to be proven before it takes effect.
    changeEmail: { enabled: false },
    // Stays on: self-serve deletion is password-gated (or session-fresh) by
    // BetterAuth, and only ever destroys the caller's OWN account.
    deleteUser: { enabled: true },
    // MFA for the deployment IdP (see `idTokenHasMfa`). Here, not in
    // `provisionUser`, because this runs BEFORE the plugin creates the user,
    // links the account or mints a session — on every one of create-user,
    // link-account and sign-in — so a refused sign-in leaves nothing behind.
    // The plugin turns the rejection into a redirect carrying `?error=<code>`,
    // which the sign-in page shows. Providers registered in Settings are not
    // gated: their claims are whatever that IdP chose to send.
    validateUserInfo: ({ user, source }, ctx) => {
      if (source.method !== "sso-oidc" || source.sso?.providerId !== DEPLOYMENT_IDP_PROVIDER_ID)
        return
      if (idTokenHasMfa(source.sso.profile)) return
      const email = typeof user.email === "string" ? user.email : ""
      securityEvent({
        event: "auth.signin",
        outcome: "denied",
        reason: SSO_MFA_REQUIRED,
        subjectRef: email ? subjectRef(email) : undefined,
        ip: clientIp(ctx.headers),
        targetKind: "sso_provider",
        targetId: DEPLOYMENT_IDP_PROVIDER_ID,
        route: "GET /api/auth/sso/callback",
        detail: { method: "sso" },
      })
      return {
        error: SSO_MFA_REQUIRED,
        errorDescription: "Sign in with multi-factor authentication to continue.",
      }
    },
  },
  secret: authSecret(),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3100",
  trustedOrigins,
  advanced: {
    // The rate limiter's key, and the session row's ip_address. Never raw
    // `X-Forwarded-For`, whose left end the client writes: BetterAuth either
    // trusts that end (≤1.6.14 — rotate the header, never get throttled) or gives
    // up on any multi-value chain and puts every such request in ONE shared
    // bucket (1.6.22 — three bad passwords from anyone and nobody signs in).
    // index.ts sets this header on every BetterAuth request, from the right end.
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  account: {
    // Stated explicitly rather than left to the default, because SSO depends on
    // it: an operator-provisioned user who later signs in through the IdP must
    // land on their EXISTING account, not a duplicate.
    //
    // Note what is NOT here — SSO provider ids CANNOT be listed in
    // `trustedProviders`. The plugin rejects that as a namespace collision
    // (422), since a trusted-provider entry would let a registered SSO id
    // inherit trust meant for a social provider. Linking therefore takes one of
    // two paths, and both need the local row to have `emailVerified` — which
    // `provision.ts` sets on purpose:
    //  - the provider declared in deployment config (`SSO_*`), trusted for its
    //    own domains (see deploymentIdp.ts). The one that works with Entra,
    //    which asserts no `email_verified`.
    //  - a provider registered in Settings, only when the IdP asserts
    //    `email_verified`. Without it: `account_not_linked`.
    accountLinking: { enabled: true },
  },
  hooks: {
    // Enforce the per-org sign-in method toggles. Both gates run BEFORE any
    // session exists — a blocked attempt must never mint one.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email") {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : ""
        if (!(await passwordSignInAllowed(email))) {
          securityEvent({
            event: "auth.signin",
            outcome: "denied",
            reason: "PASSWORD_SIGN_IN_DISABLED",
            subjectRef: email ? subjectRef(email) : undefined,
            ip: clientIp(ctx.headers),
            detail: { method: "password" },
          })
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_SIGN_IN_DISABLED",
            message: "This organization requires signing in with SSO.",
          })
        }
        return
      }

      // The deployment IdP's endpoints and org are bound late; both the redirect
      // and the callback need them. See deploymentIdp.ts.
      if (ctx.path === "/sign-in/sso" || ctx.path.startsWith("/sso/callback")) {
        await bindDeploymentIdp().catch((e) => {
          console.error("SSO provider from deployment config:", e instanceof Error ? e.message : e)
          throw new APIError("BAD_GATEWAY", {
            code: "SSO_DISCOVERY_FAILED",
            message: "The identity provider could not be reached.",
          })
        })
      }

      if (ctx.path === "/sign-in/sso") {
        // Resolve the provider ourselves so the org's toggle is checked before
        // the redirect to the IdP. An unresolvable body falls through to
        // better-auth's own error rather than one we invent.
        const provider = await resolveSignInProvider(ctx.body ?? {})
        if (!provider?.organizationId) return
        const methods = await readAuthMethods(provider.organizationId)
        if (!methods.ssoEnabled) {
          securityEvent({
            event: "auth.sso.initiated",
            outcome: "denied",
            orgId: provider.organizationId,
            reason: "SSO_DISABLED",
            ip: clientIp(ctx.headers),
          })
          throw new APIError("FORBIDDEN", {
            code: "SSO_DISABLED",
            message: "SSO is not enabled for this organization.",
          })
        }
      }
    }),
    // Security audit trail for everything BetterAuth owns: sign-in/out, SSO
    // callback, credential changes, direct org-membership calls. Pure logging —
    // it never alters the response. See authAudit.ts / docs/security-logging.md.
    after: createAuthMiddleware(async (ctx) => {
      auditAuthResponse(ctx)
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // Default the active org on EVERY new session to the user's first
        // membership. The client only calls organization.setActive on sign-up,
        // so without this a plain sign-in yields a session with no active org
        // and every RPC fails the auth middleware with NO_ACTIVE_ORG.
        before: async (session) => {
          const [m] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1)
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } }
        },
      },
    },
  },
  plugins: [
    organization({
      // Closing sign-up is not enough on its own: an already-signed-in member
      // could still spin up unlimited orgs. Orgs are provisioned by an operator
      // (`scripts/create-admin.ts`), which reaches the endpoint on better-auth's
      // "system action" path — `userId` in the body and NO session headers — and
      // is therefore exempt from this check while still firing the hooks below.
      allowUserToCreateOrganization: false,
      organizationHooks: {
        // Seed the Kahuna concepts into every new org, server-side, so it
        // can't be skipped by a failed/absent client call. Idempotent.
        afterCreateOrganization: async ({ organization, user }) => {
          try {
            await runEngineOrThrow(systemScope(organization.id, user.id), seedKahuna)
            // The creator's membership is `owner`, but membership and ACCESS are two
            // tables — without this the founding owner holds no access role, and the
            // org reads as having nobody who can configure it (which is what the
            // irreducible-floor check counts). `seedKahuna` created the presets;
            // this points the owner at theirs.
            await syncMembershipRole(organization.id, user.id, "owner")
          } catch (error) {
            console.error(`Failed to seed org ${organization.id}:`, error)
          }
        },
        // ── EVERY WAY A MEMBERSHIP CAN APPEAR ────────────────────────────────
        //
        // Membership and ACCESS are two tables, and BetterAuth's own endpoints are
        // mounted under `/api/auth/*` — so `organization/add-member` and
        // `organization/update-member-role` are reachable WITHOUT passing through
        // our routes in router.ts, and therefore without `syncMembershipRole`. A
        // member who arrives that way holds no access role at all, which under a
        // fail-closed model is an empty app rather than a visible error.
        //
        // Hooking here rather than guarding each route is the point: the hook fires
        // whatever the entry path, including ones added later.
        //
        // Never throws (see `syncMembershipRole`) — a failure must not abort a join.
        afterAddMember: async ({ member, user, organization }) => {
          await syncMembershipRole(organization.id, user.id, member.role)
        },
        afterUpdateMemberRole: async ({ member, user, organization }) => {
          await syncMembershipRole(organization.id, user.id, member.role)
        },
        afterAcceptInvitation: async ({ member, user, organization }) => {
          await syncMembershipRole(organization.id, user.id, member.role)
        },
        // Purge the org's engine data BEFORE it is deleted. Throwing here aborts
        // the deletion (BetterAuth awaits this and only deletes on success), so
        // we never end up with an absent org but orphaned engine rows.
        beforeDeleteOrganization: async ({ organization }) => {
          await purgeOrgEngineData(organization.id)
          securityEvent({ event: "org.purged", outcome: "success", orgId: organization.id })
        },
      },
    }),
    // OIDC single sign-on, one provider per org, configured in-app by the org
    // OWNER (see server/sso.ts). SAML is deliberately unused — `samlify` ships
    // as a hard dependency of this package but nothing here registers a
    // `samlConfig`, and the settings UI offers no way to.
    sso({
      // The provider declared in deployment config, if any (deploymentIdp.ts).
      // Domain verification is on ONLY for it: its entry then resolves as
      // `domainVerified`, which is what makes it trusted for account linking.
      // There is no DNS verification flow here, so a provider registered in
      // Settings stays unverified — and with this on could not sign anyone in,
      // which is why Settings refuses to register one alongside (sso.ts).
      domainVerification: { enabled: deploymentIdp !== null },
      ...(deploymentIdp ? { defaultSSO: [deploymentIdp] } : {}),
      organizationProvisioning: {
        disabled: false,
        // Everyone arrives as a plain member; promotion is a deliberate act in
        // Settings → Members. No IdP-group → role mapping, so a change on the
        // IdP side can never silently grant someone admin here.
        defaultRole: "member",
        // Used for its SIDE EFFECT as much as its return value. Membership and
        // ACCESS are two tables (see membership.ts): the SSO plugin writes the
        // `member` row through the adapter directly, so the organization
        // plugin's own hooks never fire and the new member would hold no access
        // role at all — the exact gap `syncMembershipRole` exists to close.
        //
        // This is the only hook the plugin offers that fires EXACTLY ONCE per
        // new provisioning: `assignOrganizationFromProvider` returns early when
        // a member row already exists, so a returning user never reaches here.
        // (`provisionUser` is not equivalent — it keys on user REGISTRATION, so
        // it would miss an existing account being added to a new org.)
        // `syncMembershipRole` only writes `access_role_actors` and never reads
        // `bauth_member`, so running before the member row lands is fine.
        getRole: async ({ user, provider }) => {
          if (provider.organizationId) {
            await syncMembershipRole(provider.organizationId, user.id, "member")
          }
          return "member"
        },
      },
      // THE DOMAIN GUARD, and the reason SSO here isn't an open door.
      //
      // Better-auth picks a provider from the email domain typed at sign-in,
      // but nothing stops a caller passing `providerId` directly and then
      // authenticating at the IdP as whoever they like. With an issuer like
      // `accounts.google.com` — one issuer for every Google account in
      // existence — that is the whole internet, not one company. So: reject any
      // identity whose email domain is not one the provider was registered for.
      //
      // Throwing here runs BEFORE `assignOrganizationFromProvider`, so a
      // rejected identity never gets a membership and never reaches an org. The
      // user row better-auth created moments earlier does survive, orphaned and
      // inert (no membership → `NO_ACTIVE_ORG` on every request, and no session
      // cookie was set). Left in place on purpose: deleting it would risk
      // deleting a real member whose IdP identity merely failed the check.
      provisionUserOnEveryLogin: true,
      provisionUser: async ({ user, provider }) => {
        const domain = emailDomain(user.email)
        if (!domain || !domainMatches(domain, provider.domain)) {
          securityEvent({
            event: "auth.signin",
            outcome: "denied",
            orgId: provider.organizationId,
            targetKind: "sso_provider",
            targetId: provider.providerId,
            reason: "SSO_DOMAIN_NOT_ALLOWED",
            detail: { method: "sso" },
          })
          throw new APIError("FORBIDDEN", {
            code: "SSO_DOMAIN_NOT_ALLOWED",
            message: "This identity's email domain is not allowed for this provider.",
          })
        }
        // The deployment IdP carries no organizationId, so the plugin's own
        // provisioning (and `getRole` above) skips it. See deploymentIdp.ts.
        if (provider.providerId === deploymentIdp?.providerId) await joinDeploymentOrg(user.id)
      },
    }),
  ],
})

export type Auth = typeof auth
