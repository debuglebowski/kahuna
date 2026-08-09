/**
 * End-to-end verification of concept read visibility against a RUNNING server.
 *
 * Two REAL sessions in one org — an owner and a plain member — driving the same
 * RPCs the browser calls. That is the whole point: the gate keys off the caller's
 * role, so a single-session driver could not tell enforcement from absence.
 *
 * What it proves:
 *   1. A restricted concept vanishes from the member's `listConcepts`.
 *   2. Every by-id read of it fails for the member, as NOT_FOUND (not 403).
 *   3. A relation from a visible record to a restricted one is DROPPED from the
 *      detail payload, rather than surfacing as "(unavailable)".
 *   4. The owner still sees everything, and un-restricting restores member access.
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { KingsmakerRpcs } from "@kingsmaker/contract"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { auth } from "../server/auth"
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

/** Sign in over HTTP and point the session at `orgId`; returns its cookie. */
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

/** An RPC client bound to one session cookie. */
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
  class Tag extends Context.Tag(`verify/Api-${cookie.slice(0, 8)}`)<Tag, C>() {}
  const rt = ManagedRuntime.make(Layer.scoped(Tag, make).pipe(Layer.provide(Protocol)))
  return {
    call: <A, E>(f: (c: C) => Effect.Effect<A, E>): Promise<A> =>
      rt.runPromise(Effect.flatMap(Tag, f) as Effect.Effect<A, E, never>),
    /** The failure `code`, or null when the call succeeded. */
    code: async (f: (c: C) => Effect.Effect<unknown, unknown>): Promise<string | null> => {
      const r = await rt.runPromise(
        Effect.either(Effect.flatMap(Tag, f) as Effect.Effect<unknown, { code?: string }>),
      )
      return r._tag === "Right" ? null : (r.left.code ?? "no-code")
    },
  }
}

// ── two sessions in ONE org ───────────────────────────────────────────────────
const owner = await provisionVerifyIdentity("visibility")
const memberEmail = `visibility-member-${Date.now()}@example.test`
const memberPassword = "password12345"
const m = await createUserDirect({ email: memberEmail, password: memberPassword, name: "Member" })
await auth.api.addMember({
  body: { userId: m.userId, role: "member", organizationId: owner.orgId },
})

const asOwner = clientFor(await sessionFor(owner.email, owner.password, owner.orgId))
const asMember = clientFor(await sessionFor(memberEmail, memberPassword, owner.orgId))
ok("two sessions in one org", true, `owner + member on ${owner.orgId.slice(0, 8)}`)

// ── fixture: a restricted concept with a record, plus a visible one linking to it ──
const secret = await asOwner.call((c) => c.createConcept({ name: `Payroll ${Date.now()}` }))
const amount = await asOwner.call((c) =>
  c.addField({ conceptId: secret.id, name: "Amount", kind: "text" }),
)
const secretRec = await asOwner.call((c) =>
  c.createRecord({ conceptId: secret.id, fields: { [amount.id]: "250000" } }),
)
const open = await asOwner.call((c) => c.createConcept({ name: `Person ${Date.now()}` }))
const link = await asOwner.call((c) =>
  c.addField({
    conceptId: open.id,
    name: "Payroll",
    kind: "relation",
    config: { target: secret.id },
  }),
)
const openRec = await asOwner.call((c) => c.createRecord({ conceptId: open.id, fields: {} }))
await asOwner.call((c) =>
  c.createRelation({ fieldId: link.id, fromId: openRec.id, toRecordId: secretRec.recordId }),
)

// Before restricting, the member can see both — so the assertions below are about
// the flag, not about a fixture the member never had access to.
const beforeIds = (await asMember.call((c) => c.listConcepts({}))).map((x) => x.id)
ok("member sees the concept BEFORE it is restricted", beforeIds.includes(secret.id))
const beforeDetail = await asMember.call((c) => c.getRecord({ id: openRec.id }))
ok(
  "…and sees the relation to it",
  beforeDetail.related.some((r) => r.conceptId === secret.id),
  `related=${beforeDetail.related.length}`,
)

// ── restrict it ───────────────────────────────────────────────────────────────
// A targeted DENY on the Member role — `concepts.visibility` and its setter are gone
// (migration 0022). A concept is reachable because a rule says so, so hiding one is
// a rule too: on the concept, so it leaves the list, and on its records with it.
const memberRoleId = (await asOwner.call((c) => c.listRoles())).find((r) => r.key === "member")!.id
const denyIds: Array<string> = []
for (const spec of [
  { resourceType: "concept" as const, resourceId: secret.id },
  { resourceType: "record" as const, conceptId: secret.id },
]) {
  const r = await asOwner.call((c) =>
    c.addRule({ roleId: memberRoleId, effect: "deny", actions: ["view"], ...spec }),
  )
  denyIds.push(r.id)
}
ok("owner restricts the concept", denyIds.length === 2)

// 1. gone from the member's concept list
const afterIds = (await asMember.call((c) => c.listConcepts({}))).map((x) => x.id)
ok("1. member's listConcepts EXCLUDES it", !afterIds.includes(secret.id))
ok("   …but still includes the visible one", afterIds.includes(open.id))

// 2. every by-id read fails, as NOT_FOUND
ok(
  "2. listRecords → NOT_FOUND",
  (await asMember.code((c) => c.listRecords({ conceptId: secret.id }))) === "NOT_FOUND",
  String(await asMember.code((c) => c.listRecords({ conceptId: secret.id }))),
)
ok(
  "   getRecord → NOT_FOUND",
  (await asMember.code((c) => c.getRecord({ id: secretRec.id }))) === "NOT_FOUND",
)
ok(
  "   listVersions → NOT_FOUND",
  (await asMember.code((c) => c.listVersions({ recordId: secretRec.recordId }))) === "NOT_FOUND",
)
ok(
  "   getActivity → NOT_FOUND",
  (await asMember.code((c) => c.getActivity({ subjectId: secretRec.recordId }))) === "NOT_FOUND",
)
ok(
  "   searchRecords → NOT_FOUND",
  (await asMember.code((c) => c.searchRecords({ conceptId: secret.id, query: "250" }))) ===
    "NOT_FOUND",
)
// 3. the relation edge is DROPPED from the visible record's detail
const afterDetail = await asMember.call((c) => c.getRecord({ id: openRec.id }))
ok(
  "3. relation into the restricted concept is DROPPED, not '(unavailable)'",
  !afterDetail.related.some((r) => r.conceptId === secret.id) &&
    !afterDetail.related.some((r) => r.label === "(unavailable)"),
  `related=${JSON.stringify(afterDetail.related.map((r) => r.label))}`,
)
ok("   the visible record itself still reads fine", afterDetail.recordVersion.id === openRec.id)

// 4. the owner is unaffected, and un-restricting restores access
ok(
  "4. owner still lists it",
  (await asOwner.call((c) => c.listConcepts({}))).some((x) => x.id === secret.id),
)
const ownerRows = await asOwner.call((c) => c.listRecords({ conceptId: secret.id }))
ok("   owner still reads the value", ownerRows[0]?.state[amount.id] === "250000")

for (const ruleId of denyIds) await asOwner.call((c) => c.removeRule({ ruleId }))
const restoredIds = (await asMember.call((c) => c.listConcepts({}))).map((x) => x.id)
ok("   un-restricting restores member access", restoredIds.includes(secret.id))
const restoredDetail = await asMember.call((c) => c.getRecord({ id: openRec.id }))
ok(
  "   …and the relation edge comes back",
  restoredDetail.related.some((r) => r.conceptId === secret.id),
)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
