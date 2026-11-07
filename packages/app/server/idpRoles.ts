import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { account, member, session, user } from "#db"
import { type AccessRole, AccessRoleService, isAutomationActor } from "#engine"
import { db } from "./db"
import { DEPLOYMENT_IDP_PROVIDER_ID, type DeploymentIdp, deploymentIdp } from "./deploymentIdp"
import { runEngineOrThrow, systemScope } from "./runtime"
import { securityEvent } from "./securityLog"

/**
 * ROLES FROM THE IDENTITY PROVIDER — an operator-chosen mode, off by default.
 *
 * When on, the deployment IdP (`SSO_*`, see deploymentIdp.ts) is the ONLY source of
 * which roles a person holds. Every sign-in through it reads a claim from the
 * verified ID token, maps its values onto Kahuna roles, and makes the person hold
 * exactly those: missing ones are assigned, ones the claim no longer carries are
 * taken away. Nothing in the app may change that set in between (`refusal`).
 *
 * WHAT IS GOVERNED. The ordinary `user`-kind access roles a person holds, and — only
 * when some mapping names the reserved target `owner` — the owner/member membership
 * tier. NOT governed: automation roles (no automation signs in), a member's personal
 * role (Layer 1 overrides, which belong to one person rather than being handed out),
 * and the rules inside any role. Roles are still DEFINED in the app; the IdP decides
 * who holds them.
 *
 * Protocol-neutral by construction: everything below takes a plain claims object.
 * Sign-in through the deployment IdP is OIDC today, so the OIDC default claim name is
 * what applies; the SAML default is the role attribute Entra, ADFS and most SAML IdPs
 * emit, for when a SAML deployment provider exists.
 *
 * Configured ONLY by environment, never in Settings: whether the app or the IdP owns
 * role assignment is the deployer's decision, like which IdP signs people in.
 */

export const DEFAULT_ROLE_CLAIM = {
  oidc: "roles",
  saml: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
} as const

/** The reserved mapping target for the membership tier, not an access role. */
export const OWNER_TARGET = "owner"

export const ROLES_MANAGED_BY_IDP = "ROLES_MANAGED_BY_IDP"
export const ROLES_MANAGED_MESSAGE = "Roles are managed by your identity provider."
export const SSO_NO_MAPPED_ROLE = "SSO_NO_MAPPED_ROLE"

/** One `<claim value>=<role>` pair, in the order the operator wrote them. */
export interface RoleMapping {
  readonly value: string
  readonly target: string
}

export interface IdpRoleConfig {
  /** Claim holding the roles. A top-level name, or a dotted path into nested claims. */
  readonly claim: string
  readonly map: ReadonlyArray<RoleMapping>
  /** No mapped role: refuse the sign-in, or fall back to this one role. */
  readonly unmapped: { readonly kind: "deny" } | { readonly kind: "role"; readonly target: string }
  /** Some mapping targets `owner`, so the membership tier follows the IdP too. */
  readonly ownerManaged: boolean
}

const isOwnerTarget = (t: string) => t.toLowerCase() === OWNER_TARGET

/**
 * Parse `SSO_ROLES_FROM_IDP` and friends. Null when the mode is off. Throws on anything
 * malformed, so a typo fails the boot instead of silently leaving roles in-app.
 */
export const parseIdpRoleConfig = (
  env: Readonly<Record<string, string | undefined>>,
  idp: DeploymentIdp | null,
): IdpRoleConfig | null => {
  const flag = env.SSO_ROLES_FROM_IDP?.trim().toLowerCase() ?? ""
  if (flag === "" || flag === "false") return null
  if (flag !== "true") throw new Error("SSO_ROLES_FROM_IDP must be true or false")
  if (!idp)
    throw new Error(
      "SSO_ROLES_FROM_IDP needs the identity provider in deployment config (SSO_ISSUER, …)",
    )

  const claim = env.SSO_ROLE_CLAIM?.trim() || DEFAULT_ROLE_CLAIM.oidc

  const map: RoleMapping[] = []
  for (const raw of (env.SSO_ROLE_MAP ?? "").split(",")) {
    const pair = raw.trim()
    if (!pair) continue
    const eq = pair.indexOf("=")
    const value = eq < 0 ? "" : pair.slice(0, eq).trim()
    const target = eq < 0 ? "" : pair.slice(eq + 1).trim()
    if (!value || !target) throw new Error(`SSO_ROLE_MAP: "${pair}" is not <claim value>=<role>`)
    map.push({ value, target })
  }
  if (map.length === 0)
    throw new Error("SSO_ROLE_MAP is empty — with no mapping nobody could sign in")

  const fallback = env.SSO_ROLE_UNMAPPED?.trim() || "deny"
  if (isOwnerTarget(fallback))
    throw new Error("SSO_ROLE_UNMAPPED cannot be owner — that would make everyone an owner")
  const unmapped =
    fallback.toLowerCase() === "deny"
      ? ({ kind: "deny" } as const)
      : ({ kind: "role", target: fallback } as const)

  return { claim, map, unmapped, ownerManaged: map.some((m) => isOwnerTarget(m.target)) }
}

/**
 * Parsed on first use, not at load: membership.ts reads this and deploymentIdp.ts
 * imports membership.ts, so a load-time read would run inside that import cycle,
 * before `deploymentIdp` exists. auth.ts calls it while booting, so a bad config
 * still fails the boot.
 */
let config: IdpRoleConfig | null | undefined

/** The mode's config, or null when roles are managed in the app (the default). */
export const idpRoleConfig = (): IdpRoleConfig | null => {
  if (config === undefined) config = parseIdpRoleConfig(process.env, deploymentIdp)
  return config
}

/** Test seam: the suite runs both modes against one module. Pass nothing to restore. */
export const setIdpRoleConfig = (next?: IdpRoleConfig | null): void => {
  config = next
}

/**
 * The claim's values. An exact top-level name first — SAML attribute names and some
 * OIDC claim names contain dots — then a dotted path (Keycloak's
 * `realm_access.roles`). A string is ONE value; an array contributes its strings.
 */
export const claimValues = (
  claims: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string[] => {
  if (!claims) return []
  let v: unknown
  if (Object.hasOwn(claims, name)) v = claims[name]
  else {
    v = claims
    for (const part of name.split(".")) {
      if (typeof v !== "object" || v === null || !Object.hasOwn(v, part)) return []
      v = (v as Record<string, unknown>)[part]
    }
  }
  const values = typeof v === "string" ? [v] : Array.isArray(v) ? v : []
  return [...new Set(values.filter((x): x is string => typeof x === "string" && x !== ""))]
}

/** What one sign-in's claim resolves to. */
export interface ResolvedRoles {
  /** Role id → the claim value that granted it (`null` = the unmapped fallback). */
  readonly roles: ReadonlyMap<string, string | null>
  readonly owner: boolean
  /** Mapped targets that name no role in the org — a config error worth a log line. */
  readonly unresolved: ReadonlyArray<string>
}

/** A role the IdP may hand out: people roles only (`list()` already hides personal ones). */
const governed = (r: AccessRole) => r.kind === "user"

/** A target names a role by key, then id, then name (case-insensitive). */
const findRole = (roles: ReadonlyArray<AccessRole>, target: string): AccessRole | undefined => {
  const lower = target.toLowerCase()
  return (
    roles.find((r) => r.key === target) ??
    roles.find((r) => r.id === target) ??
    roles.find((r) => r.name.toLowerCase() === lower)
  )
}

/**
 * Map claim values onto the org's roles. Pure. Matching on claim values is EXACT
 * (case-sensitive): `Kahuna.Admin` and `kahuna.admin` are different app roles at most
 * IdPs, so folding case could grant one for the other.
 */
export const resolveRoles = (
  cfg: IdpRoleConfig,
  values: ReadonlyArray<string>,
  orgRoles: ReadonlyArray<AccessRole>,
): ResolvedRoles => {
  const roles = new Map<string, string | null>()
  const unresolved: string[] = []
  let owner = false
  const candidates = orgRoles.filter(governed)
  for (const value of values) {
    for (const m of cfg.map) {
      if (m.value !== value) continue
      if (isOwnerTarget(m.target)) {
        owner = true
        continue
      }
      const role = findRole(candidates, m.target)
      if (!role) unresolved.push(m.target)
      else if (!roles.has(role.id)) roles.set(role.id, value)
    }
  }
  if (roles.size === 0 && !owner && cfg.unmapped.kind === "role") {
    const role = findRole(candidates, cfg.unmapped.target)
    if (role) roles.set(role.id, null)
    else unresolved.push(cfg.unmapped.target)
  }
  return { roles, owner, unresolved: [...new Set(unresolved)] }
}

/** Nothing to hold: under `deny` (or a fallback that names no role) the sign-in is refused. */
export const grantsNothing = (r: ResolvedRoles): boolean => r.roles.size === 0 && !r.owner

const IDP_ACTOR = "system:idp-roles"

/** The org's people roles, read as the system (provisioning, not a user action). */
export const orgRoles = (orgId: string): Promise<ReadonlyArray<AccessRole>> =>
  runEngineOrThrow(
    systemScope(orgId, IDP_ACTOR),
    Effect.flatMap(AccessRoleService, (r) => r.ensureBuiltins.pipe(Effect.andThen(r.list()))),
  )

/** Resolve one sign-in's claims against the org. */
export const resolveClaims = async (
  cfg: IdpRoleConfig,
  orgId: string,
  claims: Readonly<Record<string, unknown>> | undefined,
): Promise<ResolvedRoles> => {
  const resolved = resolveRoles(cfg, claimValues(claims, cfg.claim), await orgRoles(orgId))
  if (resolved.unresolved.length > 0)
    securityEvent({
      event: "access.role.from_idp",
      outcome: "failure",
      orgId,
      reason: "ROLE_NOT_FOUND",
      detail: { targets: resolved.unresolved.join(",") },
    })
  return resolved
}

/**
 * Make the person hold exactly what the claim resolved to. Runs on EVERY sign-in
 * through the deployment IdP, so a role removed at the IdP is removed here the next
 * time they sign in. One `access.role.from_idp` line per role taken from the claim,
 * and one per role taken away.
 *
 * Deliberately not `assertFloorHolds`: the IdP is authoritative, and the owner floor
 * (Layer 0) is not something an access-role change can remove.
 */
export const applyRoles = async (
  cfg: IdpRoleConfig,
  orgId: string,
  userId: string,
  resolved: ResolvedRoles,
): Promise<void> => {
  const changes = await runEngineOrThrow(
    systemScope(orgId, IDP_ACTOR),
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const held = (yield* roles.rolesOf(userId)).filter(governed)
      const out: Array<{ roleId: string; change: string; claim: string | null }> = []
      for (const [roleId, claim] of resolved.roles) {
        const has = held.some((h) => h.id === roleId)
        if (!has) yield* roles.assign(roleId, userId)
        out.push({ roleId, change: has ? "kept" : "granted", claim })
      }
      for (const h of held) {
        if (resolved.roles.has(h.id)) continue
        yield* roles.unassign(h.id, userId)
        out.push({ roleId: h.id, change: "removed", claim: null })
      }
      return out
    }),
  )
  for (const c of changes)
    securityEvent({
      event: "access.role.from_idp",
      outcome: "success",
      actor: IDP_ACTOR,
      orgId,
      targetKind: "user",
      targetId: userId,
      detail: {
        roleId: c.roleId,
        change: c.change,
        claim: c.claim ?? undefined,
        fallback: c.change !== "removed" && c.claim === null ? true : undefined,
      },
    })

  if (cfg.ownerManaged) await applyOwner(orgId, userId, resolved.owner)
}

/**
 * The membership tier, when a mapping targets `owner`. Written directly, like the
 * plugin's own membership rows — BetterAuth's `updateMemberRole` wants a caller
 * session and its tier check, and this is the system acting on the IdP's word. No
 * last-owner guard: the IdP decides, and an org with no owner is still administrable
 * through whoever holds the admin role.
 */
const applyOwner = async (orgId: string, userId: string, owner: boolean): Promise<void> => {
  const next = owner ? "owner" : "member"
  const [row] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row || row.role === next) {
    if (row && owner)
      securityEvent({
        event: "access.role.from_idp",
        outcome: "success",
        actor: IDP_ACTOR,
        orgId,
        targetKind: "user",
        targetId: userId,
        detail: { membership: "owner", change: "kept" },
      })
    return
  }
  await db.update(member).set({ role: next }).where(eq(member.id, row.id))
  securityEvent({
    event: "access.role.from_idp",
    outcome: "success",
    actor: IDP_ACTOR,
    orgId,
    targetKind: "user",
    targetId: userId,
    detail: { membership: next, change: owner ? "granted" : "removed" },
  })
}

/**
 * The person an IdP identity belongs to, BEFORE the plugin resolves it: the account
 * already linked to this subject, else (first SSO sign-in of an existing account) the
 * user with that address — only inside the provider's own domains, which is the
 * same trust the plugin's account linking extends.
 */
const existingUser = async (sub: string, email: string): Promise<string | null> => {
  if (sub) {
    const [linked] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, DEPLOYMENT_IDP_PROVIDER_ID), eq(account.accountId, sub)))
      .limit(1)
    if (linked) return linked.userId
  }
  const domain = email.split("@")[1]?.toLowerCase() ?? ""
  const domains = deploymentIdp?.domain.split(",") ?? []
  if (!email || !domains.includes(domain)) return null
  const [byEmail] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.toLowerCase()))
    .limit(1)
  return byEmail?.id ?? null
}

/**
 * A refused sign-in (no mapped role) must still TAKE AWAY what the IdP took away —
 * otherwise "remove every role at the IdP" would leave the last set in place, usable
 * from any session still open. Strips every governed role (and owner, when managed)
 * and ends their sessions.
 */
export const revokeForRefusedSignIn = async (
  cfg: IdpRoleConfig,
  orgId: string,
  claims: { readonly sub: string; readonly email: string },
): Promise<void> => {
  const userId = await existingUser(claims.sub, claims.email)
  if (!userId) return
  await applyRoles(cfg, orgId, userId, { roles: new Map(), owner: false, unresolved: [] })
  await db.delete(session).where(eq(session.userId, userId))
}

/**
 * THE IN-APP REFUSAL. Null when the change may go ahead; otherwise the refusal, with
 * its security log line already written. Automation actors are never governed.
 */
export const refusal = (input: {
  readonly what: string
  readonly orgId: string
  readonly actor: string
  readonly targetId?: string
  readonly route?: string
  readonly ip?: string | null
}): { readonly code: string; readonly message: string } | null => {
  if (!idpRoleConfig()) return null
  if (input.targetId && isAutomationActor(input.targetId)) return null
  securityEvent({
    event: "access.role_change.refused",
    outcome: "denied",
    actor: input.actor,
    orgId: input.orgId,
    targetKind: "user",
    targetId: input.targetId,
    reason: ROLES_MANAGED_BY_IDP,
    route: input.route,
    ip: input.ip,
    detail: { change: input.what },
  })
  return { code: ROLES_MANAGED_BY_IDP, message: ROLES_MANAGED_MESSAGE }
}
