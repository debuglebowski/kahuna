/**
 * End-to-end verification of `@` mention resolution against a RUNNING server.
 *
 * Two REAL sessions in one org — an owner and a plain member — because the whole
 * design rests on the resolver answering DIFFERENTLY per caller. A single-session
 * driver cannot tell enforcement from absence.
 *
 * What it proves:
 *   1. Before restricting, the member resolves a record mention fully.
 *   2. After restricting, the member gets href/label/subtitle all null — the link
 *      is inert — and the response leaks neither the concept name nor its id.
 *   3. That degrade is a SUCCESS, not an error: a mention must never fail a render.
 *   4. The cached label stays readable in the document (the accepted trade), while
 *      the derived `text` never carries the target's id (the anti-oracle rule).
 *   5. The owner is unaffected, and un-restricting restores the member.
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"
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
  class Tag extends Context.Tag(`verify/Api-${cookie.slice(0, 8)}`)<Tag, C>() {}
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

/** A doc whose only content is one mention of `targetId`. */
const mentionDoc = (kind: string, targetId: string, label: string) => ({
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "mention", attrs: { kind, targetId, label } }] },
    ],
  },
  text: "",
})

// ── two sessions in ONE org ───────────────────────────────────────────────────
const owner = await provisionVerifyIdentity("mentions")
const memberEmail = `mentions-member-${Date.now()}@example.test`
const memberPassword = "password12345"
const m = await createUserDirect({ email: memberEmail, password: memberPassword, name: "Member" })
await auth.api.addMember({
  body: { userId: m.userId, role: "member", organizationId: owner.orgId },
})

const asOwner = clientFor(await sessionFor(owner.email, owner.password, owner.orgId))
const asMember = clientFor(await sessionFor(memberEmail, memberPassword, owner.orgId))
ok("two sessions in one org", true, `owner + member on ${owner.orgId.slice(0, 8)}`)

// ── fixture: a restrictable concept holding the mention TARGET, and a visible
//    concept whose richtext field MENTIONS it ───────────────────────────────────
const SECRET_NAME = `Payroll ${Date.now()}`
const SECRET_LABEL = "Salary Band A"
const secret = await asOwner.call((c) => c.createConcept({ name: SECRET_NAME }))
const bandName = await asOwner.call((c) =>
  c.addField({ conceptId: secret.id, name: "Band", kind: "text" }),
)
await asOwner.call((c) => c.setConceptTitleField({ id: secret.id, titleFieldId: bandName.id }))
const secretRec = await asOwner.call((c) =>
  c.createInstance({ conceptId: secret.id, fields: { [bandName.id]: SECRET_LABEL } }),
)

const open = await asOwner.call((c) => c.createConcept({ name: `Page ${Date.now()}` }))
const body = await asOwner.call((c) =>
  c.addField({ conceptId: open.id, name: "Body", kind: "richtext" }),
)
const openRec = await asOwner.call((c) =>
  c.createInstance({
    conceptId: open.id,
    fields: { [body.id]: mentionDoc("record", secretRec.itemId, SECRET_LABEL) },
  }),
)

const target = [{ kind: "record" as const, targetId: secretRec.itemId }]

// ── 1. BEFORE restricting, the member resolves it fully ───────────────────────
const before = await asMember.call((c) => c.resolveMentions({ refs: target }))
ok(
  "1. member resolves the mention BEFORE restriction",
  before[0]?.href !== null,
  before[0]?.href ?? "null",
)
ok("   …with the real label", before[0]?.label === SECRET_LABEL, before[0]?.label ?? "null")
ok(
  "   …and the concept name as subtitle",
  before[0]?.subtitle === SECRET_NAME,
  before[0]?.subtitle ?? "null",
)

// ── restrict ──────────────────────────────────────────────────────────────────
await asOwner.call((c) => c.setConceptVisibility({ id: secret.id, visibility: "admin" }))

// ── 2. the link goes inert, and leaks nothing ─────────────────────────────────
const after = await asMember.call((c) => c.resolveMentions({ refs: target }))
const one = after[0]
ok("2. member's href is NULL — the link is inert", one?.href === null, String(one?.href))
ok("   …label is null, so the document's own label stands", one?.label === null, String(one?.label))
ok("   …subtitle is null", one?.subtitle === null, String(one?.subtitle))
const payload = JSON.stringify(after)
ok("   …the response never names the restricted concept", !payload.includes(SECRET_NAME))
ok("   …nor carries its id", !payload.includes(secret.id))

// ── 3. degraded, NOT failed: a mention must never break a render ──────────────
const code = await asMember.code((c) => c.resolveMentions({ refs: target }))
ok("3. the call SUCCEEDED (degrade, not error)", code === null, code ?? "ok")

// ── 4. the accepted trade, and the anti-oracle rule ───────────────────────────
const asMemberRec = await asMember.call((c) => c.getInstance({ id: openRec.id }))
const stored = (asMemberRec.instance.state as Record<string, { text?: string } | undefined>)[
  body.id
]
ok(
  "4. the cached label is still readable in the document (accepted)",
  (stored?.text ?? "").includes(SECRET_LABEL),
  stored?.text ?? "",
)
ok(
  "   …but the derived text never carries the target's id",
  !(stored?.text ?? "").includes(secretRec.itemId),
  stored?.text ?? "",
)

// ── 5. the owner is unaffected, and un-restricting restores the member ────────
const ownerView = await asOwner.call((c) => c.resolveMentions({ refs: target }))
ok("5. owner still resolves it", ownerView[0]?.href !== null, ownerView[0]?.href ?? "null")
ok("   …with the real label", ownerView[0]?.label === SECRET_LABEL, ownerView[0]?.label ?? "null")

await asOwner.call((c) => c.setConceptVisibility({ id: secret.id, visibility: "visible" }))
const restored = await asMember.call((c) => c.resolveMentions({ refs: target }))
ok(
  "   un-restricting RESTORES the member's link",
  restored[0]?.href !== null,
  restored[0]?.href ?? "null",
)
ok("   …and its label", restored[0]?.label === SECRET_LABEL, restored[0]?.label ?? "null")

// ── 6. backlinks DROP an unreadable source, rather than placeholdering it ─────
// The mention lives in `open`; the target is the (restrictable) `secret` record.
// Restricting the SOURCE's concept is what should make the backlink disappear.
const baseline = await asMember.call((c) => c.listBacklinks({ itemId: secretRec.itemId }))
ok(
  "6. member sees the backlink while the source is readable",
  baseline.length === 1,
  `n=${baseline.length}`,
)
ok(
  "   …naming the source's concept",
  baseline[0]?.conceptName === open.name,
  baseline[0]?.conceptName ?? "null",
)

await asOwner.call((c) => c.setConceptVisibility({ id: open.id, visibility: "admin" }))
const hidden = await asMember.call((c) => c.listBacklinks({ itemId: secretRec.itemId }))
ok("   restricting the SOURCE drops the row entirely", hidden.length === 0, `n=${hidden.length}`)
ok("   …with no placeholder naming it", !JSON.stringify(hidden).includes(open.name))
const ownerLinks = await asOwner.call((c) => c.listBacklinks({ itemId: secretRec.itemId }))
ok("   …while the owner still sees it", ownerLinks.length === 1, `n=${ownerLinks.length}`)
await asOwner.call((c) => c.setConceptVisibility({ id: open.id, visibility: "visible" }))

// ── 7. the `@` picker's record search, and what it refuses to show ───────────
const hits = await asMember.call((c) =>
  c.searchMentionableRecords({ query: SECRET_LABEL.slice(0, 6) }),
)
ok(
  "7. member's record search finds a readable record",
  hits.some((h) => h.targetId === secretRec.itemId),
  `n=${hits.length}`,
)
const bare = await asMember.call((c) => c.searchMentionableRecords({ query: "   " }))
ok("   a bare/blank query scans nothing", bare.length === 0, `n=${bare.length}`)

await asOwner.call((c) => c.setConceptVisibility({ id: secret.id, visibility: "admin" }))
const restrictedHits = await asMember.call((c) =>
  c.searchMentionableRecords({ query: SECRET_LABEL.slice(0, 6) }),
)
ok(
  "   …and a restricted concept's records are unsearchable",
  !restrictedHits.some((h) => h.targetId === secretRec.itemId),
  `n=${restrictedHits.length}`,
)
ok("   …with its label absent entirely", !JSON.stringify(restrictedHits).includes(SECRET_LABEL))
await asOwner.call((c) => c.setConceptVisibility({ id: secret.id, visibility: "visible" }))

// ── a page mention is server-null by design (resolved client-side) ────────────
const page = await asMember.call((c) =>
  c.resolveMentions({ refs: [{ kind: "page" as const, targetId: "tasks" }] }),
)
ok("page mentions come back null (client resolves GLOBAL_NAV)", page[0]?.href === null)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
