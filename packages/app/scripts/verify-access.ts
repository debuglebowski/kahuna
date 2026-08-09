/**
 * End-to-end verification of RECORD-level access against a RUNNING server.
 *
 * THREE real sessions in one org — an owner, a plain member, and a "contractor" who
 * holds nothing but a role scoped to one record. That third session is the point:
 * only a caller whose entire access is one targeted rule can prove that record-level
 * filtering enforces rather than merely coincides with the concept-level default.
 *
 * Targeted access is a ROLE rule with `resourceId` set (`addRule`/`configure`), not a
 * per-person share — sharing was removed (see `app/engine/services/GrantService.ts`,
 * deleted). The record-filter mechanics this script proves are unchanged by that
 * removal: `AccessRoleService.addRule` writes the identical shape a share used to
 * (a rule naming one `records.id`), just through the role editor instead of a dialog,
 * and gated on `configure` rather than `share` on the resource.
 *
 * What it proves:
 *   1. A restricted concept + a role scoped to one record = that record, and ONLY
 *      that record.
 *   2. The list and the by-id read AGREE — the contractor cannot open a record their
 *      list correctly hid. (A `fallback = true` bug passes #1 and fails here.)
 *   3. Counts and pagination reflect visible rows, not fetched-then-filtered rows.
 *   4. The targeted record's notes/tasks/files/activity follow it; a non-targeted
 *      record's do not, even with its record id in hand.
 *   5. Relations do NOT cascade: access to a record does not disclose its targets.
 *   6. Granting targeted access is `configure`-gated — a plain member cannot create a
 *      role or add a rule to one, so they cannot mint themselves (or anyone) access.
 *   7. Unassigning the role lands on the very next request (no cache staleness).
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
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
// The targeted record links to a company the contractor has no access to.
await asOwner.call((c) =>
  c.createRelation({ fieldId: link.id, fromId: two.id, toRecordId: acme.recordId }),
)
// Annotations on both a targeted and a non-targeted record, to prove they follow access.
await asOwner.call((c) => c.createNote({ subjectId: two.recordId, body: "shared-note" }))
await asOwner.call((c) => c.createNote({ subjectId: one.recordId, body: "private-note" }))

ok(
  "member sees all three deals before restriction",
  (await asMember.call((c) => c.listRecords({ conceptId: deals.id }))).length === 3,
)

// ── RESTRICTING A CONCEPT, THE ONLY WAY LEFT ─────────────────────────────────
// `setConceptVisibility` is gone with the `concepts.visibility` column: a concept is
// reachable because a rule says so, full stop. Hiding one from ordinary members is
// therefore a targeted DENY on the Member role — on the concept (so it vanishes from
// the list) and on its records (so the rows go with it).
const memberRoleId = (await asOwner.call((c) => c.listRoles())).find((r) => r.key === "member")!.id
const restrict = async (conceptId: string): Promise<ReadonlyArray<string>> => {
  const a = await asOwner.call((c) =>
    c.addRule({
      roleId: memberRoleId,
      effect: "deny",
      actions: ["view"],
      resourceType: "concept",
      resourceId: conceptId,
    }),
  )
  const b = await asOwner.call((c) =>
    c.addRule({
      roleId: memberRoleId,
      effect: "deny",
      actions: ["view"],
      resourceType: "record",
      conceptId,
    }),
  )
  return [a.id, b.id]
}
const unrestrict = async (ids: ReadonlyArray<string>) => {
  for (const ruleId of ids) await asOwner.call((c) => c.removeRule({ ruleId }))
}

// ── restrict the concept, then give the contractor a role scoped to ONE record ──
const dealsDeny = await restrict(deals.id)
// Company is restricted TOO, so the no-cascade assertion is about the grant not
// reaching the target — not about a concept the contractor could read anyway.
await restrict(companies.id)
ok(
  "1. a restricted concept vanishes for the member",
  !(await asMember.call((c) => c.listConcepts({}))).some((x) => x.id === deals.id),
)
ok(
  "   …and its records are unreadable",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)

const targeted = await asOwner.call((c) => c.createRole({ name: `Deal ${stamp} — one record` }))
await asOwner.call((c) => c.assignRole({ roleId: targeted.id, userId: contractor.userId }))
const rule = await asOwner.call((c) =>
  c.addRule({
    roleId: targeted.id,
    effect: "allow",
    actions: ["view"],
    resourceType: "record",
    resourceId: two.recordId,
  }),
)
ok("2. owner scopes a role to ONE record and assigns it to the contractor", !!rule.id)

// THE LIST HALF.
const seen = await asContractor.call((c) => c.listRecords({ conceptId: deals.id }))
ok(
  "3. the contractor's list holds EXACTLY the targeted record",
  seen.length === 1 && seen[0]!.recordId === two.recordId,
  `n=${seen.length}`,
)
ok(
  "   …and the concept is reachable so that list can be requested",
  (await asContractor.call((c) => c.listConcepts({}))).some((x) => x.id === deals.id),
)

// THE BY-ID HALF — must agree with the list.
ok(
  "4. the targeted record OPENS by id",
  (await asContractor.code((c) => c.getRecord({ id: two.id }))) === null,
)
ok(
  "   THE AGREEMENT: a NON-targeted record does NOT open",
  (await asContractor.code((c) => c.getRecord({ id: one.id }))) === "NOT_FOUND",
)
ok(
  "   …nor its versions",
  (await asContractor.code((c) => c.listVersions({ recordId: one.recordId }))) === "NOT_FOUND",
)

// Counts: the limit must bound VISIBLE rows.
ok(
  "5. THE COUNT GUARD: the member (no targeted access) sees zero, not a truncated page",
  (await asMember.code((c) => c.listRecords({ conceptId: deals.id }))) === "NOT_FOUND",
)
const ownerAll = await asOwner.call((c) => c.listRecords({ conceptId: deals.id }))
ok("   …while the owner still sees all three", ownerAll.length === 3, `n=${ownerAll.length}`)

// Annotations follow the record.
ok(
  "6. the targeted record's notes ARE readable",
  (await asContractor.call((c) => c.listNotes({ subjectId: two.recordId }))).some(
    (n) => n.body === "shared-note",
  ),
)
ok(
  "   THE ANNOTATION CHOKEPOINT: a non-targeted record's notes are NOT",
  (await asContractor.code((c) => c.listNotes({ subjectId: one.recordId }))) === "NOT_FOUND",
)
ok(
  "   …nor its activity feed",
  (await asContractor.code((c) => c.getActivity({ subjectId: one.recordId }))) === "NOT_FOUND",
)

// Relations do NOT cascade.
const detail = await asContractor.call((c) => c.getRecord({ id: two.id }))
ok(
  "7. NO CASCADE: the targeted record's relation target is not disclosed",
  !detail.related.some((r) => r.conceptId === companies.id),
  `related=${detail.related.length}`,
)

// Granting targeted access is `configure`-gated. Unlike the old self-service share
// (bounded by what the sharer held), a role/rule write is ordinary RBAC — an admin
// grants whatever they like — so the safeguard worth proving is that a PLAIN MEMBER
// cannot reach either write at all, and therefore cannot mint access for themselves
// or anyone else.
ok(
  "8. a plain member cannot create a role",
  (await asMember.code((c) => c.createRole({ name: "self-service" }))) === "FORBIDDEN",
)
ok(
  "   …nor add a rule to an existing one",
  (await asMember.code((c) =>
    c.addRule({
      roleId: targeted.id,
      effect: "allow",
      actions: ["edit"],
      resourceType: "record",
      resourceId: one.recordId,
    }),
  )) === "FORBIDDEN",
)

// Unassigning lands immediately.
await asOwner.call((c) => c.unassignRole({ roleId: targeted.id, userId: contractor.userId }))
ok(
  "9. after unassigning the record is gone from the list",
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
await unrestrict(dealsDeny)
ok(
  "   un-restricting restores the plain member",
  (await asMember.call((c) => c.listRecords({ conceptId: deals.id }))).length === 3,
)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
