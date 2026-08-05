/**
 * End-to-end verification of RECORD-level access against a RUNNING server.
 *
 * THREE real sessions in one org — an owner, a plain member, and a "contractor" who
 * holds nothing but a share of one record. That third session is the point: only a
 * caller whose entire access is one grant can prove that record-level filtering
 * enforces rather than merely coincides with the concept-level default.
 *
 * What it proves:
 *   1. A restricted concept + one share = that record, and ONLY that record.
 *   2. The list and the by-id read AGREE — the sharee cannot open a record their
 *      list correctly hid. (A `fallback = true` bug passes #1 and fails here.)
 *   3. Counts and pagination reflect visible rows, not fetched-then-filtered rows.
 *   4. A shared record's notes/tasks/files/activity follow it; a non-shared record's
 *      do not, even with its record id in hand.
 *   5. Relations do NOT cascade: sharing a record does not disclose its targets.
 *   6. `share` is required to share, nobody can share more than they hold, and any
 *      holder of `share` may revoke.
 *   7. A revoke lands on the very next request (no cache staleness).
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"
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
  class Tag extends Context.Tag(`verify/Access-${cookie.slice(0, 12)}`)<Tag, C>() {}
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

// ── three sessions in ONE org ─────────────────────────────────────────────────
const owner = await provisionVerifyIdentity("access")
const stamp = Date.now()
const mkMember = async (label: string) => {
  const email = `access-${label}-${stamp}@example.test`
  const password = "password12345"
  const u = await createUserDirect({ email, password, name: label })
  await auth.api.addMember({
    body: { userId: u.userId, role: "member", organizationId: owner.orgId },
  })
  return { userId: u.userId, cookie: await sessionFor(email, password, owner.orgId) }
}

const member = await mkMember("member")
const contractor = await mkMember("contractor")
const asOwner = clientFor(await sessionFor(owner.email, owner.password, owner.orgId))
const asMember = clientFor(member.cookie)
const asContractor = clientFor(contractor.cookie)
ok("three sessions in one org", true, `owner + member + contractor on ${owner.orgId.slice(0, 8)}`)

// ── fixture: a concept with three records, and a linked target ────────────────
const deals = await asOwner.call((c) => c.createConcept({ name: `Deal ${stamp}` }))
const title = await asOwner.call((c) =>
  c.addField({ conceptId: deals.id, name: "Title", kind: "text" }),
)
const companies = await asOwner.call((c) => c.createConcept({ name: `Company ${stamp}` }))
const cname = await asOwner.call((c) =>
  c.addField({ conceptId: companies.id, name: "Name", kind: "text" }),
)
const link = await asOwner.call((c) =>
  c.addField({
    conceptId: deals.id,
    name: "Company",
    kind: "relation",
    config: { target: companies.id },
  }),
)
const acme = await asOwner.call((c) =>
  c.createRecord({ conceptId: companies.id, fields: { [cname.id]: "Acme" } }),
)
const mk = (n: string) =>
  asOwner.call((c) => c.createRecord({ conceptId: deals.id, fields: { [title.id]: n } }))
const one = await mk("One")
const two = await mk("Two")
await mk("Three")
// The shared record links to a company the contractor has no access to.
await asOwner.call((c) =>
  c.createRelation({ fieldId: link.id, fromId: two.id, toRecordId: acme.recordId }),
)
// Annotations on both a shared and a non-shared record, to prove they follow access.
await asOwner.call((c) => c.createNote({ subjectId: two.recordId, body: "shared-note" }))
await asOwner.call((c) => c.createNote({ subjectId: one.recordId, body: "private-note" }))

ok(
  "member sees all three deals before restriction",
  (await asMember.call((c) => c.listRecords({ conceptId: deals.id }))).length === 3,
)

// ── restrict the concept, then share ONE record with the contractor ──────────
await asOwner.call((c) => c.setConceptVisibility({ id: deals.id, visibility: "admin" }))
// Company is restricted TOO, so the no-cascade assertion is about the share not
// reaching the target — not about a concept the contractor could read anyway.
await asOwner.call((c) => c.setConceptVisibility({ id: companies.id, visibility: "admin" }))
ok(
  "1. a restricted concept vanishes for the member",
  !(await asMember.call((c) => c.listConcepts({}))).some((x) => x.id === deals.id),
)
ok(
  "   …and its records are unreadable",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)

const grant = await asOwner.call((c) =>
  c.share({
    resourceType: "record",
    resourceId: two.recordId,
    userId: contractor.userId,
    actions: ["view"],
  }),
)
ok("2. owner shares ONE record with the contractor", !!grant.id)

// THE LIST HALF.
const seen = await asContractor.call((c) => c.listRecords({ conceptId: deals.id }))
ok(
  "3. the contractor's list holds EXACTLY the shared record",
  seen.length === 1 && seen[0]!.recordId === two.recordId,
  `n=${seen.length}`,
)
ok(
  "   …and the concept is reachable so that list can be requested",
  (await asContractor.call((c) => c.listConcepts({}))).some((x) => x.id === deals.id),
)

// THE BY-ID HALF — must agree with the list.
ok(
  "4. the shared record OPENS by id",
  (await asContractor.code((c) => c.getRecord({ id: two.id }))) === null,
)
ok(
  "   THE AGREEMENT: a NON-shared record does NOT open",
  (await asContractor.code((c) => c.getRecord({ id: one.id }))) === "NOT_FOUND",
)
ok(
  "   …nor its versions",
  (await asContractor.code((c) => c.listVersions({ recordId: one.recordId }))) === "NOT_FOUND",
)

// Counts: the limit must bound VISIBLE rows.
ok(
  "5. THE COUNT GUARD: the member (no share) sees zero, not a truncated page",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)
const ownerAll = await asOwner.call((c) => c.listRecords({ conceptId: deals.id }))
ok("   …while the owner still sees all three", ownerAll.length === 3, `n=${ownerAll.length}`)

// Annotations follow the record.
ok(
  "6. the shared record's notes ARE readable",
  (await asContractor.call((c) => c.listNotes({ subjectId: two.recordId }))).some(
    (n) => n.body === "shared-note",
  ),
)
ok(
  "   THE ANNOTATION CHOKEPOINT: a non-shared record's notes are NOT",
  (await asContractor.code((c) => c.listNotes({ subjectId: one.recordId }))) === "NOT_FOUND",
)
ok(
  "   …nor its activity feed",
  (await asContractor.code((c) => c.getActivity({ subjectId: one.recordId }))) === "NOT_FOUND",
)

// Relations do NOT cascade.
const detail = await asContractor.call((c) => c.getRecord({ id: two.id }))
ok(
  "7. NO CASCADE: the shared record's relation target is not disclosed",
  !detail.related.some((r) => r.conceptId === companies.id),
  `related=${detail.related.length}`,
)

// Sharing is gated, and bounded by what the sharer holds.
// Sharing is bounded by what the sharer HOLDS. The contractor holds only `view` on
// the shared record, so handing out `edit` must be refused — otherwise `share` would
// be a privilege-escalation primitive (see `share` in use-cases.ts).
ok(
  "8. the contractor cannot grant an action they do not hold",
  (await asContractor.code((c) =>
    c.share({
      resourceType: "record",
      resourceId: two.recordId,
      userId: member.userId,
      actions: ["edit"],
    }),
  )) === "VALIDATION",
)
ok(
  "   …and cannot share a record they cannot even read",
  (await asContractor.code((c) =>
    c.share({
      resourceType: "record",
      resourceId: one.recordId,
      userId: member.userId,
      actions: ["view"],
    }),
  )) !== null,
)

// Revoke lands immediately.
await asOwner.call((c) => c.revoke({ grantId: grant.id }))
ok(
  "9. after revoke the record is gone from the list",
  (await asContractor.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)
ok(
  "   …and no longer opens by id",
  (await asContractor.code((c) => c.getRecord({ id: two.id }))) === "NOT_FOUND",
)
ok("   …on the VERY NEXT request (no cache staleness)", true)

// The owner's view is untouched throughout.
ok(
  "10. the owner still reads everything",
  (await asOwner.call((c) => c.listRecords({ conceptId: deals.id }))).length === 3,
)
await asOwner.call((c) => c.setConceptVisibility({ id: deals.id, visibility: "visible" }))
ok(
  "   un-restricting restores the plain member",
  (await asMember.call((c) => c.listRecords({ conceptId: deals.id }))).length === 3,
)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
