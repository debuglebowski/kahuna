import { user } from "#db"
import { db } from "./db"
import { createOrgDirect, createUserDirect, makeOrgSlug } from "./provision"

/**
 * First-boot provisioning of the initial admin, from the environment.
 *
 * WHY ENV AND NOT A GENERATED PASSWORD: the credential has to reach the operator
 * on every hosting shape, and stdout does not generalise. Compose runs the
 * migrate step attached, but a Helm `pre-upgrade` Job, a Fly `release_command`
 * and a Render release phase all bury or garbage-collect that output. Env vars
 * are the one channel every platform has, so the password travels INBOUND.
 *
 * WHY NOT A FIXED DEFAULT PASSWORD: it would ship in a public repo, i.e. be known
 * before the deployment exists, while requesting a TLS cert publishes the
 * hostname to Certificate Transparency logs that scanners watch in real time.
 * That makes "delete the bootstrap admin later" a manual cleanup racing an
 * automated scan. It also buys nothing: `BETTER_AUTH_SECRET` already hard-throws
 * in production (auth.ts) and compose demands `POSTGRES_PASSWORD`, so nobody
 * reaches a running app without editing the env file this reads.
 *
 * THE INITIAL ADMIN IS MEANT TO BE TEMPORARY:
 *   1. set INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD, deploy
 *   2. sign in, add your own account in Settings -> Members
 *   3. promote it to `owner`
 *   4. delete the initial admin
 * Step 3 MUST precede step 4 — the LAST_OWNER guard (router.ts) refuses to demote
 * or remove the only owner. Note that member-delete removes the MEMBERSHIP; the
 * user row survives and needs deleting separately if you want it gone.
 *
 * Callers: `scripts/bootstrap.ts`, which the container entrypoint runs as part of
 * `migrate`. That step is single-instance by contract, which is what keeps the
 * empty-deployment check below free of a TOCTOU race between replicas.
 */
export interface InitialAdminConfig {
  readonly email: string
  readonly password: string
  readonly orgName: string
}

export type BootstrapResult =
  | {
      readonly status: "created"
      readonly email: string
      readonly userId: string
      readonly orgId: string
      readonly orgName: string
    }
  | { readonly status: "skipped"; readonly reason: "not-configured" | "already-provisioned" }

/**
 * BetterAuth's own default (`emailAndPassword.minPasswordLength`), enforced here
 * because `createUserDirect` writes the rows directly and so never passes through
 * the route that would check it. Without this a one-character
 * INITIAL_ADMIN_PASSWORD would silently become an owner credential.
 */
const MIN_PASSWORD_LENGTH = 8

/** Default org name. Renameable in Settings; override with INITIAL_ORG_NAME. */
const DEFAULT_ORG_NAME = "Kingsmaker"

/**
 * Read the bootstrap config from the environment. Null when NEITHER half is set —
 * bootstrap is opt-in, and an untouched deployment is not an error.
 *
 * A HALF-set pair throws instead of degrading to null. The two states are
 * indistinguishable to the operator otherwise: a typo'd `INITIAL_ADMIN_PASWORD`
 * reads as "bootstrap not wanted", and the deploy goes green with no account and
 * no way in. Nobody sets exactly one of these on purpose.
 */
export const readInitialAdminEnv = (): InitialAdminConfig | null => {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim()
  const password = process.env.INITIAL_ADMIN_PASSWORD
  if (!email && !password) return null
  if (!email || !password) {
    const set = email ? "INITIAL_ADMIN_EMAIL" : "INITIAL_ADMIN_PASSWORD"
    const missing = email ? "INITIAL_ADMIN_PASSWORD" : "INITIAL_ADMIN_EMAIL"
    throw new Error(`${set} is set but ${missing} is not — set both, or neither`)
  }
  return {
    email,
    password,
    orgName: process.env.INITIAL_ORG_NAME?.trim() || DEFAULT_ORG_NAME,
  }
}

/**
 * True when no account has ever existed. This — not "the initial admin is
 * missing" — is the bootstrap guard, so that deleting the initial admin after
 * handover does not resurrect it on the next deploy.
 */
export const isEmptyDeployment = async (): Promise<boolean> => {
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  return row === undefined
}

/**
 * Create the initial admin plus a seeded org, if and only if the deployment is
 * empty. Idempotent: a no-op on every subsequent run, so wiring it into the
 * migrate step costs nothing on upgrades. Never resets an existing password.
 *
 * `config` defaults to the environment; tests pass one explicitly because the
 * suite shares one database and so is never an empty deployment.
 */
export const bootstrapInitialAdmin = async (
  config: InitialAdminConfig | null = readInitialAdminEnv(),
): Promise<BootstrapResult> => {
  if (!config) return { status: "skipped", reason: "not-configured" }

  if (config.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`INITIAL_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (!(await isEmptyDeployment())) {
    return { status: "skipped", reason: "already-provisioned" }
  }

  // No name is passed: createUserDirect falls back to the email, and the admin
  // can set a real one in the app. One env var fewer to document.
  const created = await createUserDirect({ email: config.email, password: config.password })

  // Via the endpoint, not an insert: `afterCreateOrganization` is what seeds the
  // org with the Kingsmaker concepts (see auth.ts).
  const org = await createOrgDirect({
    userId: created.userId,
    name: config.orgName,
    slug: makeOrgSlug(config.orgName),
  })

  return {
    status: "created",
    email: created.email,
    userId: created.userId,
    orgId: org.id,
    orgName: config.orgName,
  }
}
