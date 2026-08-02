import "../server/env"

import { createOrgDirect, createUserDirect } from "../server/provision"

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
 */
export const provisionVerifyIdentity = async (prefix: string): Promise<VerifyIdentity> => {
  const stamp = Date.now()
  const email = `${prefix}-${stamp}@example.test`
  const password = "password12345"
  const user = await createUserDirect({ email, password, name: `${prefix} verify` })
  const org = await createOrgDirect({
    userId: user.userId,
    name: `Verify ${prefix}`,
    slug: `verify-${prefix}-${stamp}`,
  })
  return { email, password, userId: user.userId, orgId: org.id }
}
