import { createHash } from "node:crypto"
import {
  type AuditEvent,
  buildAuditEvent,
  extractClaim,
  freshness,
  IdpRoleError,
  type OidcResult,
  parseConfig,
  ROLES_MANAGED_BY_IDP,
  ROLES_MANAGED_HTTP_STATUS,
  ROLES_MANAGED_MESSAGE,
  type RoleConfig,
  resolveGrants,
  revalidateOidc,
} from "@normain/idp-role-contract"
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose"
import type { PoolClient } from "pg"
import { pool } from "./db"
import {
  bindDeploymentIdp,
  DEPLOYMENT_IDP_PROVIDER_ID,
  deploymentIdp,
  deploymentOrgId,
} from "./deploymentIdp"
import { decryptToken, encryptToken } from "./integrations/crypto"

/**
 * ROLES FROM THE IDENTITY PROVIDER — Kahuna's adapter for the shared
 * `@normain/idp-role-contract` (one release, pinned by hash, shared with Cloudable
 * and SlayZone). Off by default; the operator turns it on with `IDP_ROLES_ENABLED`.
 *
 * WHAT IS SHARED, AND NOT COPIED HERE: config parsing and validation, claim
 * extraction, claim → target mapping, the freshness deadline, the OIDC
 * revalidation orchestration and the audit event shape. This file is the Kahuna
 * side only — transport (token endpoint, ID token verification), storage (the
 * tables in auth-schema.ts), role reconciliation, and revocation.
 *
 * WHAT THE IDP GOVERNS IN KAHUNA. Which people roles a person holds (every
 * `user`-kind role that is not a personal role) and the owner/member membership
 * tier — always, whenever the mode is on: a mapping with no `owner` target means
 * nobody is owner through the IdP, and legacy owners are demoted at their next
 * verification. NOT governed: role definitions and their rules, each member's
 * personal overrides (Layer 1), automation roles and automation actors.
 *
 * Targets in `IDP_ROLE_MAPPING` are `owner` or a people role's KEY (`admin`,
 * `member`) or ID. Names are not accepted: they are renameable, and a rename must
 * not silently change who holds what.
 *
 * THE FLOW.
 * - Boot (`initIdpRoles`): parse config against the org's roles (unknown target →
 *   boot fails), then record the ACTIVATION EPOCH. Turning the mode on, or changing
 *   its config, is a new epoch and ends every human session — once, transactionally.
 * - Sign-in through the deployment IdP: the verified ID token's claim is mapped
 *   (`establishLogin`), roles reconciled, the evidence time (signed `iat`) and
 *   refresh token persisted, and the new session bound to the epoch (`bindSession`).
 *   No mapped role: refused before any session exists (`denyLogin`).
 * - Every authenticated request (`idpSessionGate`): the session must belong to the
 *   current epoch and the evidence must be younger than the interval (≤ 3600 s). At
 *   the deadline the shared `revalidateOidc` refreshes and re-verifies under a
 *   per-person lock; anything short of fresh role evidence ends the person's
 *   sessions and clears their managed roles, and the request is refused.
 */

export const SERVICE = "kahuna"
export const IDP_ACTOR = "system:idp-roles"
export const OWNER_TARGET = "owner"
export const SSO_NO_MAPPED_ROLE = "SSO_NO_MAPPED_ROLE"
export const IDP_REAUTH_REQUIRED = "IDP_REAUTH_REQUIRED"
export const IDP_REAUTH_MESSAGE = "Sign in again through your identity provider."
export { ROLES_MANAGED_BY_IDP, ROLES_MANAGED_HTTP_STATUS, ROLES_MANAGED_MESSAGE }

/** The names this branch used before the shared contract. Rejected at boot. */
export const LEGACY_KEYS = [
  "SSO_ROLES_FROM_IDP",
  "SSO_ROLE_CLAIM",
  "SSO_ROLE_MAP",
  "SSO_ROLE_UNMAPPED",
] as const

// ── config ──────────────────────────────────────────────────────────────────

let config: RoleConfig | null = null

/**
 * Whether managed mode is on. Before `initIdpRoles` has run this answers from the
 * env, so every guard fails CLOSED during boot and in scripts that never init.
 */
export const idpRolesEnabled = (): boolean =>
  config ? config.enabled : process.env.IDP_ROLES_ENABLED === "true"

/** The active config, or null when roles are managed in the app (the default). */
export const idpRoleConfig = (): RoleConfig | null => (config?.enabled ? config : null)

/** Test seam: install a parsed config without booting. Pass nothing to clear. */
export const setIdpRoleConfig = (next?: RoleConfig | null): void => {
  config = next ?? null
}

/** Unix seconds, wall clock. Swappable in tests to reach a deadline. */
/** Wall clock in MILLISECONDS; seconds are derived from it, never the reverse. */
let clockMs = (): number => Date.now()
export const nowMs = (): number => clockMs()
export const nowSec = (): number => Math.floor(clockMs() / 1000)
/** Test seam: a whole-second clock (Unix s). Pass nothing to restore. */
export const setClock = (next?: () => number): void => {
  clockMs = next ? () => next() * 1000 : () => Date.now()
}
/** Test seam: a millisecond clock, for sub-second deadlines. */
export const setClockMs = (next?: () => number): void => {
  clockMs = next ?? (() => Date.now())
}

interface RoleRow {
  readonly id: string
  readonly key: string | null
}

/** People roles the IdP may hand out: `user` kind, not anyone's personal role. */
const governedRoles = async (
  q: Pick<PoolClient, "query">,
  orgId: string,
): Promise<ReadonlyArray<RoleRow>> =>
  (
    await q.query<RoleRow>(
      `SELECT id::text AS id, key FROM access_roles
       WHERE org_id = $1 AND kind = 'user' AND personal_for IS NULL`,
      [orgId],
    )
  ).rows

/** Every valid mapping target: `owner`, and each people role's key and id. */
export const allowedTargets = async (orgId: string | null): Promise<string[]> => {
  // Before bootstrap there is no org yet; only the seeded keys can be named.
  if (!orgId) return [OWNER_TARGET, "admin", "member"]
  const roles = await governedRoles(pool, orgId)
  return [OWNER_TARGET, ...roles.flatMap((r) => (r.key ? [r.key, r.id] : [r.id]))]
}

/** Identifies one activation: the config and the IdP it trusts. */
export const configFingerprint = (cfg: RoleConfig): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        claim: cfg.claim,
        mapping: Object.keys(cfg.mapping)
          .sort()
          .map((k) => [k, cfg.mapping[k]]),
        intervalSec: cfg.intervalSec,
        issuer: deploymentIdp?.oidcConfig.issuer ?? null,
        clientId: deploymentIdp?.oidcConfig.clientId ?? null,
      }),
    )
    .digest("hex")

/** Parse the operator's config. Throws `IdpRoleError` on anything malformed. */
export const loadIdpRoleConfig = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<RoleConfig> => {
  const cfg = parseConfig(env, await allowedTargets(await deploymentOrgId()), {
    legacyKeys: LEGACY_KEYS,
  })
  if (cfg.enabled && !deploymentIdp)
    throw new IdpRoleError(
      "INVALID_IDP_ROLE_CONFIG",
      "IDP_ROLES_ENABLED needs the identity provider in deployment config (SSO_ISSUER, …).",
    )
  return cfg
}

/**
 * Boot: parse, then record the activation. Throws (and the server refuses to
 * start) on malformed config, an unknown target, or the mode without an IdP.
 */
export const initIdpRoles = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ActivationOutcome> => {
  const cfg = await loadIdpRoleConfig(env)
  config = cfg
  return activate(cfg)
}

// ── audit ───────────────────────────────────────────────────────────────────

type AuditSink = (line: string) => void
const stdout: AuditSink = (line) => {
  if (process.env.VITEST) return
  process.stdout.write(`${line}\n`)
}
let auditSink: AuditSink = stdout
/** Test seam. */
export const setIdpAuditSink = (next?: AuditSink): void => {
  auditSink = next ?? stdout
}

/**
 * One line per role decision or refusal, in the shared contract's shape (the
 * builder allowlists fields and sorts grants), inside the security log envelope
 * (`type: "security"`). Subjects and actors are opaque ids; reasons static codes.
 */
export const idpAudit = (
  input: Omit<AuditEvent, "service">,
  outcome: "success" | "denied" | "failure",
): void => {
  try {
    const e = buildAuditEvent({ ...input, service: SERVICE })
    auditSink(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: "security",
        level: outcome === "success" ? "info" : "warn",
        outcome,
        ...e,
      }),
    )
  } catch {
    /* an audit line never turns a decision into a failure */
  }
}

// ── revocation listeners (CLI device flow, SSE streams) ─────────────────────

type Revoked = (userId: string | null) => void
const revokedListeners = new Set<Revoked>()
/** `null` = every person (activation). Registered by cli-auth.ts and stream.ts. */
export const onHumanRevoked = (fn: Revoked): void => {
  revokedListeners.add(fn)
}
const notifyRevoked = (userId: string | null) => {
  for (const fn of revokedListeners) {
    try {
      fn(userId)
    } catch {
      /* best effort; the DB revocation already happened */
    }
  }
}

// ── transactions ────────────────────────────────────────────────────────────

const inTransaction = async <A>(f: (c: PoolClient) => Promise<A>): Promise<A> => {
  const c = await pool.connect()
  try {
    await c.query("BEGIN")
    const out = await f(c)
    await c.query("COMMIT")
    return out
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/** Run inside a SAVEPOINT, so a failed write leaves the transaction usable. */
const savepoint = async <A>(c: PoolClient, f: () => Promise<A>): Promise<A> => {
  await c.query("SAVEPOINT idp_step")
  try {
    const out = await f()
    await c.query("RELEASE SAVEPOINT idp_step")
    return out
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT idp_step").catch(() => {})
    throw e
  }
}

/** Serialize everything that changes one person's IdP state, across replicas. */
const lockPerson = (c: PoolClient, userId: string) =>
  c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`idp-roles:${userId}`])

// ── activation epoch ────────────────────────────────────────────────────────

export type ActivationOutcome = {
  readonly epoch: number
  readonly change: "activated" | "config_changed" | "deactivated" | "unchanged"
  readonly sessionsRevoked: number
}

/**
 * Persist the mode and its config identity. Idempotent: the same config on every
 * boot changes nothing. Off → on, or a config change while on, is a NEW epoch and
 * ends every human session in the same transaction; sessions minted after it
 * (bound to the new epoch) are untouched by any later boot. On → off is persisted
 * too, so the next on is a new activation again. Automation actors hold no sessions
 * and are untouched.
 */
export const activate = async (cfg: RoleConfig): Promise<ActivationOutcome> => {
  const out = await inTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('idp-roles:activation', 0))")
    await c.query("INSERT INTO idp_role_activation (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
    const {
      rows: [row],
    } = await c.query<{ enabled: boolean; epoch: number; fingerprint: string | null }>(
      "SELECT enabled, epoch, fingerprint FROM idp_role_activation WHERE id = 1 FOR UPDATE",
    )
    if (!row) throw new Error("idp_role_activation row missing")
    if (!cfg.enabled) {
      if (!row.enabled)
        return { epoch: row.epoch, change: "unchanged" as const, sessionsRevoked: 0 }
      await c.query(
        "UPDATE idp_role_activation SET enabled = false, changed_at = now() WHERE id = 1",
      )
      return { epoch: row.epoch, change: "deactivated" as const, sessionsRevoked: 0 }
    }
    const fp = configFingerprint(cfg)
    if (row.enabled && row.fingerprint === fp)
      return { epoch: row.epoch, change: "unchanged" as const, sessionsRevoked: 0 }
    const epoch = row.epoch + 1
    await c.query(
      `UPDATE idp_role_activation
       SET enabled = true, epoch = $1, fingerprint = $2, changed_at = now() WHERE id = 1`,
      [epoch, fp],
    )
    // Every human session and CLI credential (a CLI holds a session cookie), and
    // the plugin's copy of IdP tokens.
    const revoked = await c.query("DELETE FROM bauth_session")
    await c.query(
      "UPDATE bauth_account SET refresh_token = NULL, access_token = NULL, id_token = NULL WHERE provider_id = $1",
      [DEPLOYMENT_IDP_PROVIDER_ID],
    )
    // Evidence from an earlier epoch is never fresh again; drop its refresh tokens.
    await c.query(
      `UPDATE idp_role_identities SET refresh_token = NULL, revision = revision + 1
       WHERE epoch <> $1`,
      [epoch],
    )
    return {
      epoch,
      change: row.enabled ? ("config_changed" as const) : ("activated" as const),
      sessionsRevoked: revoked.rowCount ?? 0,
    }
  })
  if (out.change === "activated" || out.change === "config_changed") notifyRevoked(null)
  if (out.change !== "unchanged")
    idpAudit(
      {
        event: "idp_roles.activation",
        actor: IDP_ACTOR,
        subject: "deployment",
        source: "activation",
        previousGrants: [],
        newGrants: [],
        reason: out.change,
      },
      "success",
    )
  return out
}

/** What the database says about the mode — the source every replica fences on. */
type Persisted = {
  readonly enabled: boolean
  readonly epoch: number
  readonly fingerprint: string | null
}
const readPersisted = async (): Promise<Persisted | null> => {
  const { rows } = await pool.query<Persisted>(
    "SELECT enabled, epoch, fingerprint FROM idp_role_activation WHERE id = 1",
  )
  return rows[0] ?? null
}

/**
 * Whether roles are managed by the IdP for THIS request: on in this process's
 * config OR in the database. A replica still running with the mode off (a rolling
 * deploy, a stale env) must not hand out roles or accept passwords once any replica
 * activated the mode. A database error answers yes — fail closed.
 */
export const idpManaged = async (): Promise<boolean> => {
  if (idpRolesEnabled()) return true
  try {
    return (await readPersisted())?.enabled === true
  } catch {
    return true
  }
}

/**
 * THE FENCE, inside a transaction: share-lock the activation row and return its
 * epoch and config identity — only if the mode is on there AND that identity is
 * this process's config. Null otherwise; callers then write nothing. Holding the
 * share lock keeps any activation from landing until the transaction ends.
 */
const fence = async (
  c: PoolClient,
  cfg: RoleConfig,
): Promise<{
  readonly epoch: number
  readonly fingerprint: string
  /** The activation's second (Unix s, floored): evidence must be signed AFTER it. */
  readonly cutoff: number
} | null> => {
  const { rows } = await c.query<{
    enabled: boolean
    epoch: number
    fingerprint: string | null
    cutoff: string
  }>(
    `SELECT enabled, epoch, fingerprint, floor(extract(epoch FROM changed_at))::bigint AS cutoff
     FROM idp_role_activation WHERE id = 1 FOR SHARE`,
  )
  const a = rows[0]
  const fp = configFingerprint(cfg)
  return a?.enabled && a.fingerprint === fp
    ? { epoch: a.epoch, fingerprint: fp, cutoff: Number(a.cutoff) }
    : null
}

// ── role reconciliation ─────────────────────────────────────────────────────

/** The targets a person holds now, in mapping vocabulary (key, else id; `owner`). */
const heldTargets = async (c: PoolClient, orgId: string, userId: string): Promise<string[]> => {
  const { rows } = await c.query<{ target: string }>(
    `SELECT coalesce(r.key, r.id::text) AS target
     FROM access_role_actors a
     JOIN access_roles r ON r.id = a.role_id AND r.org_id = a.org_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND r.kind = 'user' AND r.personal_for IS NULL`,
    [orgId, userId],
  )
  const tier = await c.query<{ role: string }>(
    "SELECT role FROM bauth_member WHERE organization_id = $1 AND user_id = $2",
    [orgId, userId],
  )
  return [
    ...rows.map((r) => r.target),
    ...(tier.rows[0]?.role === OWNER_TARGET ? [OWNER_TARGET] : []),
  ]
}

/**
 * Make the person hold exactly `targets`: people roles assigned and removed, the
 * owner/member tier set. Same transaction as the evidence it rests on. A target
 * that names no role any more (deleted after boot) throws, so the caller fails
 * closed instead of granting less than the IdP said without noticing.
 */
const reconcile = async (
  c: PoolClient,
  orgId: string,
  userId: string,
  targets: readonly string[],
): Promise<{ previous: string[]; next: string[] }> => {
  const previous = await heldTargets(c, orgId, userId)
  const roles = await governedRoles(c, orgId)
  const want = new Set<string>()
  for (const t of targets) {
    if (t === OWNER_TARGET) continue
    const role = roles.find((r) => r.key === t || r.id === t)
    if (!role) throw new IdpRoleError("UNKNOWN_TARGET", "mapped role no longer exists")
    want.add(role.id)
  }
  const { rows: heldRows } = await c.query<{ role_id: string }>(
    `SELECT a.role_id::text AS role_id FROM access_role_actors a
     JOIN access_roles r ON r.id = a.role_id AND r.org_id = a.org_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND r.kind = 'user' AND r.personal_for IS NULL`,
    [orgId, userId],
  )
  const held = new Set(heldRows.map((r) => r.role_id))
  let changed = false
  for (const id of held) {
    if (want.has(id)) continue
    await c.query(
      "DELETE FROM access_role_actors WHERE org_id = $1 AND role_id = $2 AND actor_id = $3",
      [orgId, id, userId],
    )
    changed = true
  }
  for (const id of want) {
    if (held.has(id)) continue
    await c.query(
      `INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (role_id, actor_id) DO NOTHING`,
      [orgId, id, userId, IDP_ACTOR],
    )
    changed = true
  }
  const tier = targets.includes(OWNER_TARGET) ? OWNER_TARGET : "member"
  const tierChange = await c.query(
    "UPDATE bauth_member SET role = $3 WHERE organization_id = $1 AND user_id = $2 AND role <> $3",
    [orgId, userId, tier],
  )
  if (changed || (tierChange.rowCount ?? 0) > 0)
    await c.query(
      `INSERT INTO access_policy_versions (org_id, version, updated_at) VALUES ($1, 1, now())
       ON CONFLICT (org_id)
       DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now()`,
      [orgId],
    )
  return { previous, next: await heldTargets(c, orgId, userId) }
}

/**
 * Clear managed authorization and revoke every human credential of one person:
 * managed roles and owner tier removed, sessions (browser and CLI) deleted, refresh
 * token dropped. The evidence time is left as it was — never extended. Fenced on
 * the identity revision when one exists: if a newer verification won the race,
 * this throws and revokes nothing.
 */
const clearAndRevoke = async (
  c: PoolClient,
  orgId: string | null,
  userId: string,
  expectedRevision: number | null,
): Promise<{ previous: string[]; next: string[] }> => {
  if (expectedRevision !== null) {
    const fenced = await c.query(
      `UPDATE idp_role_identities
       SET grants = '[]'::jsonb, refresh_token = NULL, revision = revision + 1, updated_at = now()
       WHERE user_id = $1 AND revision = $2`,
      [userId, expectedRevision],
    )
    if (fenced.rowCount !== 1) throw new Error("idp identity changed concurrently")
  }
  const changes = orgId ? await reconcile(c, orgId, userId, []) : { previous: [], next: [] }
  // Every session BOUND to the person (browser and CLI alike — a CLI holds the
  // same cookie). Unbound ones are already unusable in managed mode, and one may
  // be a newer sign-in waiting for this person's lock: it must survive.
  await c.query(
    "DELETE FROM bauth_session WHERE id IN (SELECT session_id FROM idp_role_sessions WHERE user_id = $1)",
    [userId],
  )
  await clearAccountTokens(c, userId)
  return changes
}

// ── OIDC transport ──────────────────────────────────────────────────────────

let jwks: JWTVerifyGetKey | null = null
let jwksUrl = ""

/**
 * Verify an ID token from the deployment IdP: signature against its JWKS, issuer,
 * audience (and `azp` when the audience is shared), expiry, and the claims the
 * shared flow needs. Returns the verified payload — never a merely decoded one.
 */
export const verifyIdToken = async (token: string): Promise<Record<string, unknown>> => {
  if (!deploymentIdp) throw new Error("no deployment IdP")
  await bindDeploymentIdp()
  const cfg = deploymentIdp.oidcConfig
  if (!cfg.jwksEndpoint) throw new Error("no JWKS endpoint")
  if (!jwks || jwksUrl !== cfg.jwksEndpoint) {
    jwks = createRemoteJWKSet(new URL(cfg.jwksEndpoint))
    jwksUrl = cfg.jwksEndpoint
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384"],
    requiredClaims: ["sub", "iat", "exp"],
    currentDate: new Date(nowSec() * 1000),
  })
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== cfg.clientId)
    throw new Error("azp does not name this client")
  return payload as Record<string, unknown>
}

/** Spend a refresh token at the IdP's token endpoint. */
export const refreshTokens = async (
  refreshToken: string,
): Promise<{ idToken?: string | null; refreshToken?: string | null }> => {
  if (!deploymentIdp) throw new Error("no deployment IdP")
  await bindDeploymentIdp()
  const cfg = deploymentIdp.oidcConfig
  if (!cfg.tokenEndpoint) throw new Error("no token endpoint")
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: cfg.scopes?.join(" ") ?? "openid",
  })
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  }
  if (cfg.tokenEndpointAuthentication === "client_secret_post") {
    body.set("client_id", cfg.clientId)
    body.set("client_secret", cfg.clientSecret ?? "")
  } else {
    const basic = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret ?? "")}`
    headers.authorization = `Basic ${Buffer.from(basic).toString("base64")}`
  }
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, unknown>
  return {
    idToken: typeof json.id_token === "string" ? json.id_token : null,
    // Absent = keep the current one; present = rotation.
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
  }
}

let transport = { refresh: refreshTokens, verifyIdToken }
/** Test seam: replace the IdP transport. Pass nothing to restore. */
export const setIdpTransport = (next?: Partial<typeof transport>): void => {
  transport = { refresh: refreshTokens, verifyIdToken, ...next }
}

// ── sign-in ─────────────────────────────────────────────────────────────────

/** Why a verified claim grants nothing: missing/malformed claim, or no mapping. */
export const loginDenial = (
  claims: Readonly<Record<string, unknown>> | undefined,
): "invalid_claim" | "no_mapped_role" | null => {
  const cfg = idpRoleConfig()
  if (!cfg) return null
  if (extractClaim(claims, cfg.claim).length === 0) return "invalid_claim"
  return resolveGrants(claims, cfg).length === 0 ? "no_mapped_role" : null
}

/**
 * The person an IdP subject belongs to, before the plugin resolves it: the identity
 * row, else the account already linked to this subject.
 */
const userForSubject = async (sub: string): Promise<string | null> => {
  if (!sub) return null
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM idp_role_identities WHERE subject = $1
     UNION ALL
     SELECT user_id FROM bauth_account WHERE provider_id = 'deployment-idp' AND account_id = $1
     LIMIT 1`,
    [sub],
  )
  return rows[0]?.user_id ?? null
}

/** A signed `iat`, or null when the token carries none usable. */
const signedIat = (claims: Readonly<Record<string, unknown>> | undefined): number | null => {
  const iat = claims?.iat
  return typeof iat === "number" && Number.isInteger(iat) && iat >= 0 ? iat : null
}

type IdentityRow = {
  readonly subject: string
  readonly epoch: number
  readonly revision: number
  readonly verified_at: string | null
  readonly denied_at: string | null
  readonly grants: string[]
  readonly refresh_token: string | null
  readonly fingerprint: string | null
}
const lockIdentity = async (c: PoolClient, userId: string): Promise<IdentityRow | undefined> =>
  (
    await c.query<IdentityRow>(
      `SELECT subject, epoch, revision, verified_at, denied_at, grants, refresh_token, fingerprint
       FROM idp_role_identities WHERE user_id = $1 FOR UPDATE`,
      [userId],
    )
  ).rows[0]

const num = (v: string | null): number | null => (v === null ? null : Number(v))

/**
 * A verified sign-in whose claim maps to nothing: refuse it (the caller does), and
 * take away what the person held — roles, owner tier, every bound session — so
 * removing the last role at the IdP is not undone by a session still open.
 *
 * FENCED on signed time: a denial older than the evidence already recorded is a
 * late delivery and changes nothing; a newer one is recorded (`denied_at`), so an
 * older MAPPED assertion arriving after it cannot restore access. And on the mode:
 * if the database is not in this process's config, nothing is written.
 */
export const denyLogin = async (
  claims: Readonly<Record<string, unknown>> | undefined,
  reason: "invalid_claim" | "no_mapped_role",
  fallbackSubject: string,
): Promise<void> => {
  const cfg = idpRoleConfig()
  const sub = typeof claims?.sub === "string" ? claims.sub : ""
  const iat = signedIat(claims)
  const userId = await userForSubject(sub)
  let changes: Changes = { previous: [], next: [] }
  let outcome: "revoked" | "stale_evidence" | "config_mismatch" | "no_identity" = "no_identity"
  if (userId && cfg && iat !== null) {
    const orgId = await deploymentOrgId()
    outcome = await inTransaction(async (c) => {
      await lockPerson(c, userId)
      const f = await fence(c, cfg)
      if (!f) return "config_mismatch" as const
      const row = await lockIdentity(c, userId)
      if (row && row.epoch === f.epoch && row.verified_at !== null && iat < Number(row.verified_at))
        return "stale_evidence" as const
      changes = await clearAndRevoke(c, orgId, userId, row ? row.revision : null)
      await c.query(
        `INSERT INTO idp_role_identities (user_id, subject, epoch, denied_at, fingerprint)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           denied_at = GREATEST(coalesce(idp_role_identities.denied_at, 0), EXCLUDED.denied_at),
           revision = idp_role_identities.revision + 1, updated_at = now()`,
        [userId, sub, f.epoch, iat, f.fingerprint],
      )
      return "revoked" as const
    })
    if (outcome === "revoked") notifyRevoked(userId)
  }
  idpAudit(
    {
      event: "idp_roles.denied",
      actor: IDP_ACTOR,
      subject: userId ?? fallbackSubject,
      source: "oidc",
      previousGrants: changes.previous,
      newGrants: [],
      reason: outcome === "revoked" || outcome === "no_identity" ? reason : outcome,
    },
    "denied",
  )
}

/**
 * A verified sign-in through the deployment IdP: reconcile roles from the claim and
 * persist the evidence — its signed `iat`, never the receipt time — bound to the
 * current epoch AND config identity, under the activation row's share lock: a
 * process still holding an older config cannot write its grants into a newer
 * activation. The refresh token is kept here and ONLY here (the plugin's copy on
 * the account row is cleared), so one serialized path spends it. Throws (failing
 * the sign-in) on anything short of fresh, mapped, newest evidence.
 */
export const establishLogin = async (
  userId: string,
  claims: Readonly<Record<string, unknown>>,
  refreshToken: string | null | undefined,
): Promise<void> => {
  const cfg = idpRoleConfig()
  if (!cfg) throw new IdpRoleError("NOT_ACTIVE", "mode not active in this process")
  const orgId = await deploymentOrgId()
  if (!orgId) throw new IdpRoleError("NO_ORG", "no deployment org")
  const sub = claims.sub
  const iat = signedIat(claims)
  const now = nowSec()
  if (typeof sub !== "string" || !sub) throw new IdpRoleError(SSO_NO_MAPPED_ROLE, "no subject")
  if (iat === null || iat > now || now - iat >= cfg.intervalSec)
    throw new IdpRoleError(SSO_NO_MAPPED_ROLE, "stale evidence")
  const grants = resolveGrants(claims, cfg)
  if (grants.length === 0) throw new IdpRoleError(SSO_NO_MAPPED_ROLE, "no mapped role")

  const changes = await inTransaction(async (c) => {
    await lockPerson(c, userId)
    const f = await fence(c, cfg)
    if (!f) throw new IdpRoleError(IDP_CONFIG_MISMATCH, "config differs from the deployment's")
    // EVIDENCE CUTOFF: signed strictly after the activation's second. A token issued
    // before (or in the same second as) the activation — a sign-in that was pending
    // across it, a replayed or cached token — never mints a session in this epoch.
    // `iat` has one-second resolution, so the same second is refused, not guessed:
    // a sign-in in the activation's own second is retried a second later.
    if (iat <= f.cutoff) throw new IdpRoleError(SSO_NO_MAPPED_ROLE, "evidence predates activation")
    const prior = await lockIdentity(c, userId)
    if (prior) {
      const verified = prior.epoch === f.epoch ? num(prior.verified_at) : null
      const denied = num(prior.denied_at)
      if ((verified !== null && iat < verified) || (denied !== null && iat <= denied))
        throw new IdpRoleError(SSO_NO_MAPPED_ROLE, "older than recorded evidence")
    }
    const result = await reconcile(c, orgId, userId, grants)
    await c.query(
      `INSERT INTO idp_role_identities
         (user_id, subject, epoch, revision, verified_at, grants, refresh_token, fingerprint, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         subject = EXCLUDED.subject, epoch = EXCLUDED.epoch,
         revision = idp_role_identities.revision + 1, verified_at = EXCLUDED.verified_at,
         grants = EXCLUDED.grants, refresh_token = EXCLUDED.refresh_token,
         fingerprint = EXCLUDED.fingerprint, updated_at = now()`,
      [
        userId,
        sub,
        f.epoch,
        iat,
        JSON.stringify(grants),
        encryptToken(refreshToken ?? null),
        f.fingerprint,
      ],
    )
    await clearAccountTokens(c, userId)
    return result
  })
  idpAudit(
    {
      event: "idp_roles.granted",
      actor: IDP_ACTOR,
      subject: userId,
      source: "oidc",
      previousGrants: changes.previous,
      newGrants: changes.next,
      reason: "login",
    },
    "success",
  )
}

/**
 * ONE refresh-token store. The SSO plugin also writes the tokens onto the account
 * row, where BetterAuth's generic `/refresh-token` and `/get-access-token` could
 * spend them outside the per-person lock (and those routes are refused in managed
 * mode, auth.ts). Clear that copy so nothing but `revalidate` holds a usable one.
 */
const clearAccountTokens = (c: PoolClient, userId: string) =>
  c.query(
    `UPDATE bauth_account SET refresh_token = NULL, access_token = NULL, id_token = NULL,
       access_token_expires_at = NULL, refresh_token_expires_at = NULL
     WHERE user_id = $1 AND provider_id = $2`,
    [userId, DEPLOYMENT_IDP_PROVIDER_ID],
  )

/**
 * Bind a session just minted by a verified IdP sign-in to the current epoch. Only
 * if the person's evidence is in that epoch AND config identity, and that config
 * is this process's — a session from any other path never gets a row, and is
 * refused by the gate.
 */
export const bindSession = async (sessionId: string, userId: string): Promise<void> => {
  const cfg = idpRoleConfig()
  if (!cfg) return
  await pool.query(
    `INSERT INTO idp_role_sessions (session_id, user_id, epoch)
     SELECT $1, i.user_id, i.epoch FROM idp_role_identities i
     JOIN idp_role_activation a
       ON a.id = 1 AND a.enabled AND a.epoch = i.epoch
      AND a.fingerprint = i.fingerprint AND a.fingerprint = $3
     WHERE i.user_id = $2 AND i.verified_at IS NOT NULL AND jsonb_array_length(i.grants) > 0
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, userId, configFingerprint(cfg)],
  )
}

// ── the gate ────────────────────────────────────────────────────────────────

export type GateResult =
  | { readonly ok: true; readonly deadline?: number }
  | {
      readonly ok: false
      readonly status: number
      readonly code: string
      readonly message: string
    }

const OK: GateResult = { ok: true }
export const IDP_CONFIG_MISMATCH = "IDP_ROLES_CONFIG_MISMATCH"
const mismatch = (userId: string): GateResult => {
  idpAudit(
    {
      event: "idp_roles.denied",
      actor: IDP_ACTOR,
      subject: userId,
      source: "activation",
      previousGrants: [],
      newGrants: [],
      reason: "config_mismatch",
    },
    "denied",
  )
  return {
    ok: false,
    status: 503,
    code: IDP_CONFIG_MISMATCH,
    message:
      "This server's identity provider settings differ from the deployment's. Try again shortly.",
  }
}
const reauth = (): GateResult => ({
  ok: false,
  status: 401,
  code: IDP_REAUTH_REQUIRED,
  message: IDP_REAUTH_MESSAGE,
})

/**
 * THE GATE, at every authenticated entry point (RPC, `/api/*` routes, SSE open and
 * its deadline, the CLI routes, BetterAuth's own endpoints over HTTP).
 *
 * Fenced on the PERSISTED activation, in one snapshot, whatever this process
 * believes: both off is the untouched default; otherwise mode and config identity
 * must match exactly (a mismatch is refused without any write). Then the session
 * must be bound to the current epoch, and the person's evidence — in that same
 * epoch and config — younger than the interval. At the deadline, `revalidate`,
 * which fences again inside its own transaction. Fails closed on every error.
 * `deadline` (Unix s) is when this answer stops holding.
 */
export const idpSessionGate = async (sessionId: string, userId: string): Promise<GateResult> => {
  const cfg = idpRoleConfig()
  try {
    const { rows } = await pool.query<{
      enabled: boolean
      fingerprint: string | null
      bound: boolean
      verified_at: string | null
      grants: string[] | null
    }>(
      `SELECT a.enabled, a.fingerprint, s.session_id IS NOT NULL AS bound,
              i.verified_at, i.grants
       FROM idp_role_activation a
       LEFT JOIN idp_role_sessions s
         ON s.session_id = $1 AND s.user_id = $2 AND s.epoch = a.epoch
       LEFT JOIN idp_role_identities i
         ON i.user_id = s.user_id AND i.epoch = s.epoch AND i.fingerprint = a.fingerprint
       WHERE a.id = 1`,
      [sessionId, userId],
    )
    const row = rows[0]
    const persistedOn = row?.enabled === true
    if (!idpRolesEnabled() && !persistedOn) return OK
    if (!cfg || !row || !persistedOn || row.fingerprint !== configFingerprint(cfg))
      return mismatch(userId)
    if (!row.bound) {
      // Not minted by a verified sign-in in this epoch: unusable, so end it.
      await pool.query("DELETE FROM bauth_session WHERE id = $1", [sessionId])
      idpAudit(
        {
          event: "idp_roles.denied",
          actor: IDP_ACTOR,
          subject: userId,
          source: "oidc",
          previousGrants: [],
          newGrants: [],
          reason: "session_not_in_epoch",
        },
        "denied",
      )
      return reauth()
    }
    const verifiedAt = num(row.verified_at)
    if (
      (row.grants?.length ?? 0) > 0 &&
      verifiedAt !== null &&
      freshness(nowSec(), verifiedAt, cfg.intervalSec) === "ok"
    )
      return { ok: true, deadline: verifiedAt + cfg.intervalSec }
    const result = await revalidate(userId)
    if (result.status === "mismatch") return mismatch(userId)
    return result.status === "ok" && result.verifiedAt !== null
      ? { ok: true, deadline: result.verifiedAt + cfg.intervalSec }
      : reauth()
  } catch {
    return reauth()
  }
}

type Changes = { previous: string[]; next: string[] }
export type RevalidateResult = OidcResult | { readonly status: "mismatch" }

/**
 * Revalidate one person through the SHARED orchestration (`revalidateOidc`), in one
 * transaction holding: the per-person lock (two requests at the deadline spend the
 * refresh token once; a sign-in waits), a SHARE lock on the activation row (no
 * activation can land mid-refresh), and the identity row. The config identity and
 * epoch are captured under those locks; a mismatch returns without writing, and
 * both callbacks are fenced on the captured revision, epoch and fingerprint.
 *
 * `requireSso` deletes only sessions BOUND to the person: a sign-in whose session
 * the plugin committed before it reached our lock is not yet bound, survives, and
 * is bound only if its own (newer) evidence is accepted.
 */
export const revalidate = async (
  userId: string,
  opts: { readonly force?: boolean } = {},
): Promise<RevalidateResult> => {
  const cfg = idpRoleConfig()
  if (!cfg) return { status: "mismatch" }
  const orgId = await deploymentOrgId()
  const state: { changes: Changes; revoked: boolean } = {
    changes: { previous: [], next: [] },
    revoked: false,
  }
  const result = await inTransaction(async (c): Promise<RevalidateResult> => {
    await lockPerson(c, userId)
    const f = await fence(c, cfg)
    if (!f) return { status: "mismatch" }
    const row = await lockIdentity(c, userId)
    if (!row || row.epoch !== f.epoch || row.fingerprint !== f.fingerprint)
      // Evidence from another activation: never fresh, and no session of this
      // epoch can rest on it. Nothing to revoke; sign in again.
      return { status: "require_sso", reason: "stale_evidence", grants: [], verifiedAt: null }
    state.changes = { previous: row.grants, next: row.grants }
    let revision = row.revision
    return revalidateOidc({
      config: cfg,
      now: nowSec(),
      verifiedAt: num(row.verified_at),
      subject: row.subject,
      currentGrants: row.grants,
      refreshToken: decryptToken(row.refresh_token),
      force: opts.force ?? false,
      hooks: {
        getNow: nowSec,
        refresh: (t) => transport.refresh(t),
        verifyIdToken: (t) => transport.verifyIdToken(t),
        persistVerified: (s) =>
          savepoint(c, async () => {
            if (!orgId) throw new Error("no deployment org")
            state.changes = await reconcile(c, orgId, userId, s.grants)
            const keep = !("refreshToken" in s)
            const updated = await c.query(
              `UPDATE idp_role_identities
               SET verified_at = $5, grants = $6::jsonb,
                   refresh_token = CASE WHEN $7::boolean THEN refresh_token ELSE $8 END,
                   revision = revision + 1, updated_at = now()
               WHERE user_id = $1 AND revision = $2 AND epoch = $3 AND fingerprint = $4`,
              [
                userId,
                revision,
                f.epoch,
                f.fingerprint,
                s.verifiedAt,
                JSON.stringify(s.grants),
                keep,
                keep ? null : encryptToken(s.refreshToken ?? null),
              ],
            )
            if (updated.rowCount !== 1) throw new Error("idp identity changed concurrently")
            revision += 1
          }),
        requireSso: () =>
          savepoint(c, async () => {
            state.changes = await clearAndRevoke(c, orgId, userId, revision)
            state.revoked = true
          }),
      },
    })
  })
  if (state.revoked) notifyRevoked(userId)
  if (result.status === "mismatch") return result
  if (result.status === "ok") {
    if (result.reason !== "fresh")
      idpAudit(
        {
          event: "idp_roles.revalidated",
          actor: IDP_ACTOR,
          subject: userId,
          source: "oidc",
          previousGrants: state.changes.previous,
          newGrants: state.changes.next,
          reason: result.reason,
        },
        "success",
      )
  } else
    idpAudit(
      {
        event: "idp_roles.denied",
        actor: IDP_ACTOR,
        subject: userId,
        source: "oidc",
        previousGrants: state.changes.previous,
        newGrants: [],
        reason: result.reason,
      },
      "denied",
    )
  return result
}

// ── live streams ────────────────────────────────────────────────────────────

/**
 * What an open stream's right to emit rests on, read from the DATABASE: the
 * session still exists and is unexpired, the persisted mode/epoch/config identity,
 * whether the session is bound to that epoch, and (managed) the person's evidence
 * revision and grants. Captured when the stream opens
 * and compared before every emission (stream.ts): a revocation, activation, config
 * change or denial made by ANY server changes it, so the stream stops without
 * waiting for an in-process notice. Applies to streams opened with the mode off
 * too. Null on error — callers fail closed.
 */
export const streamFenceKey = async (sessionId: string): Promise<string | null> => {
  try {
    const { rows } = await pool.query<{
      live: boolean
      enabled: boolean | null
      epoch: number | null
      fingerprint: string | null
      bound: boolean
      identity: string | null
    }>(
      `SELECT EXISTS (SELECT 1 FROM bauth_session WHERE id = $1 AND expires_at > now()) AS live,
              a.enabled, a.epoch, a.fingerprint,
              EXISTS (SELECT 1 FROM idp_role_sessions s
                      WHERE s.session_id = $1 AND s.epoch = a.epoch) AS bound,
              (SELECT i.revision::text || ':' || i.grants::text
               FROM idp_role_sessions s
               JOIN idp_role_identities i ON i.user_id = s.user_id AND i.epoch = s.epoch
               WHERE s.session_id = $1 AND s.epoch = a.epoch) AS identity
       FROM (SELECT 1) AS one LEFT JOIN idp_role_activation a ON a.id = 1`,
      [sessionId],
    )
    const r = rows[0]
    if (!r?.live) return null
    // `identity` = the managed person's evidence revision + grants: every grant
    // change (a demotion by a newer sign-in, a revalidation, a denial) bumps it, so
    // an open stream never emits under roles the person no longer holds. Null with
    // the mode off, where nothing about it changes.
    return JSON.stringify([r.enabled === true, r.epoch, r.fingerprint, r.bound, r.identity])
  } catch {
    return null
  }
}

// ── refused in-app changes ──────────────────────────────────────────────────

/**
 * THE IN-APP REFUSAL for a change to who holds a managed role or the owner tier
 * (UI, API, CLI all arrive through rpc.ts / router.ts). Null when it may go ahead;
 * otherwise the refusal, already audited. Automation actors are never governed.
 */
export const refusal = async (input: {
  readonly what: string
  readonly actor: string
  readonly targetId?: string
}): Promise<{
  readonly status: number
  readonly code: string
  readonly message: string
} | null> => {
  if (!(await idpManaged())) return null
  if (input.targetId?.startsWith("system:automation:")) return null
  idpAudit(
    {
      event: "idp_roles.local_change_refused",
      actor: input.actor,
      subject: input.targetId ?? "",
      source: "local",
      previousGrants: [],
      newGrants: [],
      reason: input.what,
    },
    "denied",
  )
  return {
    status: ROLES_MANAGED_HTTP_STATUS,
    code: ROLES_MANAGED_BY_IDP,
    message: ROLES_MANAGED_MESSAGE,
  }
}

/** Password sign-in in managed mode: refused, SSO required. Audited when refused. */
export const refusePassword = async (subject: string): Promise<boolean> => {
  if (!(await idpManaged())) return false
  idpAudit(
    {
      event: "idp_roles.denied",
      actor: IDP_ACTOR,
      subject,
      source: "local",
      previousGrants: [],
      newGrants: [],
      reason: "password_sign_in_disabled",
    },
    "denied",
  )
  return true
}
