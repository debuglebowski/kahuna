import "../server/env"

import { createOrgDirect, createUserDirect, makeOrgSlug } from "../server/provision"

/**
 * CLI: `bun scripts/create-admin.ts <email> <password> <name> <orgName>` —
 * bootstrap a brand-new deployment: one owner account plus one seeded org.
 *
 * NOT the usual path any more: setting INITIAL_ADMIN_EMAIL /
 * INITIAL_ADMIN_PASSWORD does this automatically on first boot (see
 * server/bootstrap.ts). This stays as the manual escape hatch — a deployment
 * that already has accounts (so the automatic guard declines), a second org, or
 * an explicit name.
 *
 * Needed because self-serve sign-up AND self-serve org creation are both closed
 * (see server/auth.ts), so there is otherwise no way to get the FIRST account
 * into an empty database. Going through better-auth's org endpoint (rather than
 * inserting rows) is what makes the org arrive seeded with the Kingsmaker
 * concepts — `afterCreateOrganization` still fires.
 *
 * THE BOOTSTRAP ADMIN IS MEANT TO BE TEMPORARY. Intended sequence:
 *   1. bun scripts/create-admin.ts ...      ← owner + seeded org
 *   2. bun scripts/create-user.ts ...       ← once per real person
 *   3. sign in as the admin, add each of them in Settings → Members
 *   4. promote one real person to `owner`
 *   5. deactivate the bootstrap admin, then delete them
 * Step 4 MUST precede step 5: the last-owner guard refuses to demote or remove
 * the only owner. Note the member-delete route removes the MEMBERSHIP; the user
 * row itself survives and needs deleting separately if you want it gone.
 *
 * Runs against whatever `DATABASE_URL` resolves to (root `.env` in dev) — point
 * it at the intended DB before running.
 */
const [email, password, name, orgName] = process.argv.slice(2)
if (!email || !password || !name || !orgName) {
  console.error("usage: bun scripts/create-admin.ts <email> <password> <name> <orgName>")
  process.exit(1)
}

const user = await createUserDirect({ email, password, name })
if (!user.created) console.log(`note: ${user.email} already existed — reusing it`)

// One org per deployment, so this refuses when one already exists. That is the
// common case for a mistaken re-run — report it as a single line rather than a
// stack trace, since it is an operator error and not a crash.
const org = await createOrgDirect({
  userId: user.userId,
  name: orgName,
  slug: makeOrgSlug(orgName),
}).catch((err: unknown) => {
  console.error(`failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

console.log(`owner:  ${user.email} (${user.userId})`)
console.log(`org:    ${orgName} (${org.id}) — seeded`)
console.log(
  "next:   sign in, add real users by email, promote one to owner, then delete this admin",
)

process.exit(0)
