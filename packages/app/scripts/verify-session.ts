import "../server/env"

import { auth } from "../server/auth"
import { createUserDirect } from "../server/provision"

/**
 * Shared bootstrap for the verify drivers: an account + seeded org, provisioned
 * WITHOUT the (now closed) sign-up route.
 *
 * WHY: these scripts used to POST `/api/auth/sign-up/email` and
 * `/api/auth/organization/create`. Both are refused now — sign-up is disabled and
 * members may not create orgs (see server/auth.ts). The rows are therefore
 * written in-process against the same `DATABASE_URL` the server uses (these
 * scripts already load the root `.env`), and each driver then signs in over HTTP
 * through its OWN `req`/`j` helper, so its cookie plumbing is untouched.
 *
 * Requires the server under test to be pointed at the same database.
 */
export interface VerifyIdentity {
  readonly email: string
  readonly password: string
  readonly userId: string
  readonly orgId: string
}

/**
 * Provision `<prefix>-<ts>@example.test` plus a seeded org owned by them.
 * The caller signs in and calls `organization/set-active` itself.
 *
 * `auth.api.createOrganization` directly, NOT `createOrgDirect`: that enforces ONE ORG
 * PER DEPLOYMENT (see server/provision.ts), which is right for production and fatal
 * here — every driver needs its own org for isolation, and the second one to run would
 * die at fixture setup. The constraint's own comment names this bypass as the intended
 * escape hatch for tests, and it lives in application code rather than a DB index
 * precisely so this is possible.
 *
 * The bypass is safe: this file is reachable only from `scripts/verify-*.ts`, which
 * never run in production. It still goes through the endpoint (not raw inserts), so
 * `afterCreateOrganization` fires and the org arrives seeded.
 */
export const provisionVerifyIdentity = async (prefix: string): Promise<VerifyIdentity> => {
  const stamp = Date.now()
  const email = `${prefix}-${stamp}@example.test`
  const password = "password12345"
  const user = await createUserDirect({ email, password, name: `${prefix} verify` })
  const org = await auth.api.createOrganization({
    body: {
      name: `Verify ${prefix}`,
      slug: `verify-${prefix}-${stamp}`,
      // `userId` with no session headers is better-auth's "system action" path, which
      // is what makes this reachable while `allowUserToCreateOrganization` is false.
      userId: user.userId,
    },
  })
  if (!org) throw new Error(`failed to create verify org for "${prefix}"`)
  return { email, password, userId: user.userId, orgId: org.id }
}
