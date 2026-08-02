import "../server/env"

import { createOrgDirect, createUserDirect } from "../server/provision"

/**
 * CLI: `bun scripts/create-admin.ts <email> <password> <name> <orgName>` —
 * bootstrap a brand-new deployment: one owner account plus one seeded org.
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

/** URL-safe unique slug. Mirrors `src/lib/org.ts` (never surfaced in the UI). */
const slugFor = (raw: string): string => {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${base || "org"}-${Math.random().toString(36).slice(2, 7)}`
}

const user = await createUserDirect({ email, password, name })
if (!user.created) console.log(`note: ${user.email} already existed — reusing it`)

const org = await createOrgDirect({ userId: user.userId, name: orgName, slug: slugFor(orgName) })

console.log(`owner:  ${user.email} (${user.userId})`)
console.log(`org:    ${orgName} (${org.id}) — seeded`)
console.log(
  "next:   sign in, add real users by email, promote one to owner, then delete this admin",
)

process.exit(0)
