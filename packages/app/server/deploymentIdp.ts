import { randomUUID } from "node:crypto"
import type { OIDCConfig } from "@better-auth/sso"
import { and, eq } from "drizzle-orm"
import { member, organization } from "#db"
import { db } from "./db"
import { syncMembershipRole } from "./membership"

/**
 * The identity provider declared by DEPLOYMENT CONFIG (`SSO_*` env), when there is
 * one. Same model as Cloudable's `defaultSSO` and the SlayZone hub: which IdP may
 * sign people in is decided by the operator in the deploy repo, not by whoever
 * holds an owner session.
 *
 * WHY — ACCOUNT LINKING. An operator-provisioned user (the bootstrap owner, anyone
 * added before SSO) already has a local account, and their first SSO sign-in has to
 * attach to it. better-auth links only for a TRUSTED provider, or when the IdP
 * asserts `email_verified` (and `trustEmailVerified` is set). Entra asserts no
 * `email_verified` at all, so a provider registered in Settings ends every such
 * sign-in in `account_not_linked`. A `defaultSSO` entry, with domain verification
 * enabled, resolves as `domainVerified: true` — which is what makes it trusted for
 * the addresses in `SSO_DOMAINS` (`isTrustedProvider` in the plugin's callback).
 *
 * That trust is safe only because the provider cannot be changed from inside the
 * app: Settings shows it read-only and refuses to register or remove one (sso.ts),
 * and the plugin itself refuses to register an id that collides with a
 * `defaultSSO` entry.
 *
 * THE ENDPOINTS ARE BOUND LATE (`bindDeploymentIdp`). The plugin can discover
 * them itself, but then requires EVERY discovered URL to be a trusted origin — and
 * Entra's userinfo endpoint is on graph.microsoft.com. So we read the discovery
 * document ourselves and pass authorize/token/JWKS explicitly. Userinfo is left out
 * ON PURPOSE: without it the plugin reads the ID token, after verifying its
 * signature, audience and issuer.
 *
 * NO `organizationId` ON THE ENTRY, though the plugin would provision members from
 * it: its sign-in route builds the provider without that field and its callback
 * with it, so the fingerprint it stores in the state no longer matches and every
 * sign-in fails `sso_provider_changed_during_authentication` (better-auth 1.7).
 * `joinDeploymentOrg` does the provisioning instead, from auth.ts.
 */

export const DEPLOYMENT_IDP_PROVIDER_ID = "deployment-idp"

const SSO_ENV = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "SSO_DOMAINS"] as const

/** The plugin's `defaultSSO` element. */
export interface DeploymentIdp {
  readonly providerId: string
  /** Comma-separated, as the plugin's domain matcher expects. */
  readonly domain: string
  readonly oidcConfig: OIDCConfig
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * All four `SSO_*` variables or none. Throws on anything half-set or malformed, so a
 * typo fails the boot instead of quietly leaving SSO on the in-app path.
 */
export const parseDeploymentIdp = (
  env: Readonly<Record<string, string | undefined>>,
  isProd: boolean,
): DeploymentIdp | null => {
  const [issuer = "", clientId = "", clientSecret = "", domainList = ""] = SSO_ENV.map(
    (k) => env[k]?.trim() ?? "",
  )
  if (!issuer && !clientId && !clientSecret && !domainList) return null
  const missing = SSO_ENV.filter((k) => !env[k]?.trim())
  if (missing.length > 0)
    throw new Error(`Set all of ${SSO_ENV.join(", ")}, or none. Missing: ${missing.join(", ")}`)

  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new Error("SSO_ISSUER is not a URL")
  }
  // Plain http only for a local test IdP, and never in production.
  if (url.protocol !== "https:" && (isProd || !LOOPBACK.has(url.hostname)))
    throw new Error("SSO_ISSUER must use https")

  const domains = domainList
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  if (domains.length === 0 || domains.some((d) => d.includes("@") || d.includes("/")))
    throw new Error("SSO_DOMAINS must be bare email domains, comma-separated (e.g. acme.com)")

  return {
    providerId: DEPLOYMENT_IDP_PROVIDER_ID,
    domain: domains.join(","),
    oidcConfig: {
      issuer,
      clientId,
      clientSecret,
      pkce: true,
      discoveryEndpoint: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      // No offline_access: nothing here calls the IdP after sign-in.
      scopes: ["openid", "email", "profile"],
    },
  }
}

export const deploymentIdp = parseDeploymentIdp(process.env, process.env.NODE_ENV === "production")

/** Read the discovery document and pin the endpoints onto the config. */
const discoverEndpoints = async (cfg: OIDCConfig): Promise<void> => {
  const res = await fetch(cfg.discoveryEndpoint, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`SSO discovery failed: HTTP ${res.status}`)
  const doc = (await res.json()) as Record<string, unknown>
  // The document must speak for the configured issuer, or every ID token check
  // downstream would be against the wrong one.
  if (doc.issuer !== cfg.issuer) throw new Error("SSO discovery: issuer does not match SSO_ISSUER")
  const endpoint = (key: string): string => {
    const v = doc[key]
    if (typeof v !== "string" || !v) throw new Error(`SSO discovery: no ${key}`)
    return v
  }
  const methods = doc.token_endpoint_auth_methods_supported
  cfg.authorizationEndpoint = endpoint("authorization_endpoint")
  cfg.tokenEndpoint = endpoint("token_endpoint")
  cfg.jwksEndpoint = endpoint("jwks_uri")
  // Basic is the spec default when the IdP lists nothing.
  cfg.tokenEndpointAuthentication =
    Array.isArray(methods) &&
    !methods.includes("client_secret_basic") &&
    methods.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic"
}

/** Cached once it succeeds; a failure (IdP unreachable) is retried on the next call. */
let endpoints: Promise<void> | null = null

type OrgResolver = () => Promise<string | null>

/** The deployment's one org (see `createOrgDirect`), or null before bootstrap. */
const singleOrg: OrgResolver = async () => {
  const rows = await db.select({ id: organization.id }).from(organization).limit(2)
  return rows.length === 1 ? (rows[0]?.id ?? null) : null
}
let orgResolver: OrgResolver = singleOrg

/** Test seam: the suite shares one database holding many orgs. Pass nothing to restore. */
export const setDeploymentOrgResolver = (next?: OrgResolver): void => {
  orgResolver = next ?? singleOrg
}

export const deploymentOrgId = (): Promise<string | null> => orgResolver()

/**
 * Fill in the endpoints. Called before every SSO sign-in and callback (auth.ts), so
 * it does not depend on boot order. No-op without `SSO_*`.
 */
export const bindDeploymentIdp = async (): Promise<void> => {
  if (!deploymentIdp) return
  endpoints ??= discoverEndpoints(deploymentIdp.oidcConfig).catch((e) => {
    endpoints = null
    throw e
  })
  await endpoints
}

/**
 * Make someone who signed in through the deployment IdP a member of the
 * deployment's org, as the plugin does for a provider with an org: plain `member`,
 * once — an existing membership (and its role) is left alone. Written directly,
 * like the plugin's, so `syncMembershipRole` gives them their access role. No org
 * (before bootstrap): nothing, rather than a guess.
 */
export const joinDeploymentOrg = async (userId: string): Promise<void> => {
  const orgId = await deploymentOrgId()
  if (!orgId) return
  const [existing] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (existing) return
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role: "member",
    createdAt: new Date(),
  })
  await syncMembershipRole(orgId, userId, "member")
}

/** Refusal code for a deployment-IdP sign-in whose ID token shows no MFA. */
export const SSO_MFA_REQUIRED = "SSO_MFA_REQUIRED"

/**
 * THE MFA GATE: true only when the ID token's `amr` lists `mfa`. Kahuna has no
 * second factor of its own, and the IdP decides when to ask for one (Entra
 * Security Defaults, with no Conditional Access, only sometimes does) — so a
 * sign-in the IdP let through on a password alone is refused here.
 *
 * Fails closed: no `amr`, or not an array, is a refusal. `claims` is the VERIFIED
 * ID token because the deployment IdP has no userinfo endpoint (see the header);
 * give it one and the plugin hands over userinfo claims instead, which carry no
 * `amr` — every sign-in would then be refused, not silently admitted.
 *
 * Entra v2 emits `amr` only as an optional claim: add `amr` to the app
 * registration's ID token claims, or nobody gets in.
 */
export const idTokenHasMfa = (claims: Readonly<Record<string, unknown>> | undefined): boolean => {
  const amr = claims?.amr
  return Array.isArray(amr) && amr.includes("mfa")
}
