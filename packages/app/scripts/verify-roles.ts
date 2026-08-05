/**
 * End-to-end verification of ROLE MANAGEMENT against a RUNNING server.
 *
 * Two sessions: an owner (who may configure) and a plain member (who may not).
 *
 * What it proves:
 *   1. Role NAMES are readable by any member; role RULES are not.
 *   2. A custom role can be created, given a rule, assigned — and that the rule
 *      takes effect on the assignee's very next request.
 *   3. A condition on a rule ("records I created") filters records for real.
 *   4. THE FLOOR: the org cannot be left with nobody able to configure it.
 *   5. A preset role cannot be deleted (the seed would silently re-create it).
 *   6. The effective-access report is self-serve for yourself, gated for others.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { KingsmakerRpcs } from "@kingsmaker/contract"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { auth } from "../server/auth"
import { pool } from "../server/db"
import { createUserDirect } from "../server/provision"
import { provisionVerifyIdentity } from "./verify-session"

const API = process.env.API ?? "http://localhost:3199"
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5199"

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

const cookieFrom = (res: Response): string =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ")

const sessionFor = async (email: string, password: string, orgId: string): Promise<string> => {
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${await res.text()}`)
  const cookie = cookieFrom(res)
  const act = await fetch(`${API}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    body: JSON.stringify({ organizationId: orgId }),
  })
  if (!act.ok) throw new Error(`set-active failed (${act.status}): ${await act.text()}`)
  return cookie
}

const clientFor = (cookie: string) => {
  const CookieFetch = Layer.succeed(FetchHttpClient.Fetch, ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), cookie } })) as typeof fetch)
  const Protocol = RpcClient.layerProtocolHttp({ url: `${API}/api/rpc` }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CookieFetch),
    Layer.provide(RpcSerialization.layerNdjson),
  )
  const make = RpcClient.make(KingsmakerRpcs)
  type C = Effect.Effect.Success<typeof make>
  class Tag extends Context.Tag(`verify/Roles-${cookie.slice(0, 12)}`)<Tag, C>() {}
  const rt = ManagedRuntime.make(Layer.scoped(Tag, make).pipe(Layer.provide(Protocol)))
  return {
    call: <A, E>(f: (c: C) => Effect.Effect<A, E>): Promise<A> =>
      rt.runPromise(Effect.flatMap(Tag, f) as Effect.Effect<A, E, never>),
    code: async (f: (c: C) => Effect.Effect<unknown, unknown>): Promise<string | null> => {
      const r = await rt.runPromise(
        Effect.either(Effect.flatMap(Tag, f) as Effect.Effect<unknown, { code?: string }>),
      )
      return r._tag === "Right" ? null : (r.left.code ?? "no-code")
    },
  }
}

const owner = await provisionVerifyIdentity("roles")
const stamp = Date.now()
const email = `roles-member-${stamp}@example.test`
const password = "password12345"
const m = await createUserDirect({ email, password, name: "Member" })
await auth.api.addMember({
  body: { userId: m.userId, role: "member", organizationId: owner.orgId },
})
const asOwner = clientFor(await sessionFor(owner.email, owner.password, owner.orgId))
const asMember = clientFor(await sessionFor(email, password, owner.orgId))
ok("two sessions in one org", true, owner.orgId.slice(0, 8))

// 1. names public, rules gated.
const roles = await asMember.call((c) => c.listRoles())
ok("1. any member reads role NAMES", roles.length >= 4, `n=${roles.length}`)
const memberPreset = roles.find((r) => r.key === "member")!
ok(
  "   …but NOT the rules inside a role",
  (await asMember.code((c) => c.listRules({ roleId: memberPreset.id }))) === "FORBIDDEN",
)
ok(
  "   the owner can",
  (await asOwner.code((c) => c.listRules({ roleId: memberPreset.id }))) === null,
)

// 2. a custom role, a rule, an assignment — and it takes effect at once.
const deals = await asOwner.call((c) => c.createConcept({ name: `Deal ${stamp}` }))
const title = await asOwner.call((c) =>
  c.addField({ conceptId: deals.id, name: "Title", kind: "text" }),
)
const rec = await asOwner.call((c) =>
  c.createRecord({ conceptId: deals.id, fields: { [title.id]: "Secret" } }),
)
await asOwner.call((c) => c.setConceptVisibility({ id: deals.id, visibility: "admin" }))
ok(
  "2. the member cannot see the restricted concept",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)
const sales = await asOwner.call((c) => c.createRole({ name: `Sales ${stamp}` }))
ok("   a custom role is created", !!sales.id)
await asOwner.call((c) =>
  c.addRule({
    roleId: sales.id,
    effect: "allow",
    actions: ["view"],
    resourceType: "concept",
    resourceId: deals.id,
  }),
)
ok(
  "   the rule alone changes nothing (not yet assigned)",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)
await asOwner.call((c) => c.assignRole({ roleId: sales.id, userId: m.userId }))
const nowSees = await asMember.call((c) => c.listRecords({ conceptId: deals.id }))
ok("   ASSIGNED → the member sees it immediately", nowSees.length === 1, `n=${nowSees.length}`)
ok(
  "   …and the role shows on them",
  (await asMember.call((c) => c.rolesOf({ userId: m.userId }))).some((r) => r.id === sales.id),
)

// 3. a CONDITION on a rule.
const mine = await asMember.call((c) =>
  c.createRecord({ conceptId: deals.id, fields: { [title.id]: "Mine" } }),
)
ok("3. the member creates a record of their own", !!mine.id)
const scoped = await asOwner.call((c) => c.createRole({ name: `Own only ${stamp}` }))
await asOwner.call((c) =>
  c.addRule({
    roleId: scoped.id,
    effect: "allow",
    actions: ["view"],
    resourceType: "record",
    conceptId: deals.id,
    condition: { kind: "actorIs", who: "creator" },
  }),
)
// Swap the blanket concept role for the conditional record one.
await asOwner.call((c) => c.unassignRole({ roleId: sales.id, userId: m.userId }))
await asOwner.call((c) => c.assignRole({ roleId: scoped.id, userId: m.userId }))
const onlyMine = await asMember.call((c) => c.listRecords({ conceptId: deals.id }))
ok(
  "   a condition filters for real — only their OWN record",
  onlyMine.length === 1 && onlyMine[0]!.recordId === mine.recordId,
  `n=${onlyMine.length}`,
)
ok(
  "   …and the owner's record does not open by id",
  (await asMember.code((c) => c.getRecord({ id: rec.id }))) === "NOT_FOUND",
)

// 4. THE FLOOR.
const ownerRole = (await asOwner.call((c) => c.listRoles())).find((r) => r.key === "owner")!
const floorCode = await asOwner.code((c) =>
  c.unassignRole({ roleId: ownerRole.id, userId: owner.userId }),
)
ok("4. THE FLOOR: the last configure-holder cannot be unassigned", floorCode === "VALIDATION")
ok(
  "   …and the org is still administrable",
  (await asOwner.code((c) => c.listRules({ roleId: ownerRole.id }))) === null,
)

// 5. presets are undeletable.
ok(
  "5. a preset role cannot be deleted",
  (await asOwner.code((c) => c.deleteRole({ id: memberPreset.id }))) === "VALIDATION",
)
ok("   …but a custom one can", (await asOwner.code((c) => c.deleteRole({ id: sales.id }))) === null)

// 6. the effective-access report.
const selfReport = await asMember.call((c) => c.effectiveAccess({}))
ok("6. a member reads their OWN effective access", selfReport.userId === m.userId)
ok(
  "   …and it names what grants it",
  selfReport.roles.some((r) => r.id === scoped.id),
)
ok(
  "   …but cannot read someone else's",
  (await asMember.code((c) => c.effectiveAccess({ userId: owner.userId }))) === "FORBIDDEN",
)
ok(
  "   the owner can read anyone's",
  (await asOwner.call((c) => c.effectiveAccess({ userId: m.userId }))).userId === m.userId,
)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
