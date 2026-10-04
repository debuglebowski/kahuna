/**
 * End-to-end verification of the singleRecord feature (plan slices 3–10).
 *
 * Signs up a fresh user + org, then drives the REAL RPCs the browser calls —
 * through the same Effect client `src/lib/api.ts` builds — so every assertion
 * exercises the running server rather than a test-layer stand-in: the atomic
 * toggle, the five guards behind the affordances slice 10 hides, `/c/<slug>`
 * resolution, sidebar entries, widget binding, and the concept-delete cascade.
 *
 * What it deliberately does NOT cover: whether the UI actually hides those
 * buttons. It proves the engine refuses the calls (so a leftover button could
 * only ever error) and that every read path a screen needs returns the right
 * shape — the browser pass is still what checks the rendering.
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */

import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { KahunaRpcs } from "@kahunalabs/contract"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { provisionVerifyIdentity } from "./verify-session"

const API = process.env.API ?? "http://localhost:3199"
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5199"
let cookie = ""

const req = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}), origin: ORIGIN },
  })
  const setC = res.headers.getSetCookie?.() ?? []
  if (setC.length) cookie = setC.map((c) => c.split(";")[0]).join("; ")
  return res
}

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

// ── session ──
// Provisioned in-process: sign-up and member org-creation are both closed
// server-side (see server/auth.ts + scripts/verify-session.ts).
const identity = await provisionVerifyIdentity("single-record")
ok("identity provisioned (org seeds concepts)", !!identity.orgId, identity.email)
const signIn = await req("/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: identity.email, password: identity.password }),
})
ok("sign-in", signIn.ok, `${signIn.status}`)
if (!signIn.ok) {
  console.log(await signIn.text())
  process.exit(1)
}
const setActive = await req("/api/auth/organization/set-active", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ organizationId: identity.orgId }),
})
ok("org active on the session", setActive.ok, `${setActive.status}`)

// ── the real RPC client, cookie-authenticated ──
const CookieFetch = Layer.succeed(FetchHttpClient.Fetch, ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), cookie } })) as typeof fetch)
const ProtocolLive = RpcClient.layerProtocolHttp({ url: `${API}/api/rpc` }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CookieFetch),
  Layer.provide(RpcSerialization.layerNdjson),
)
const makeClient = RpcClient.make(KahunaRpcs)
type Client = Effect.Effect.Success<typeof makeClient>
class ApiClient extends Context.Tag("verify/ApiClient")<ApiClient, Client>() {}
const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)
const call = <A, E>(f: (c: Client) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f) as Effect.Effect<A, E, never>)

/** The `RpcError.code` a call fails with, or null if it succeeded.
 *
 *  Runs through `Effect.either` rather than catching the rejection: a rejected
 *  `runPromise` throws a `FiberFailure` whose `message` is the rendered cause and
 *  which exposes no `code` at all, so a try/catch can only string-match. Reading
 *  the typed failure channel is what makes "refused with THIS code" assertable
 *  instead of "refused with something whose text mentions…". */
const failCode = async (f: (c: Client) => Effect.Effect<unknown, unknown>) => {
  const result = await runtime.runPromise(
    Effect.either(
      Effect.flatMap(ApiClient, f) as Effect.Effect<unknown, { code?: string; message?: string }>,
    ),
  )
  return result._tag === "Right" ? null : (result.left.code ?? `no code: ${result.left.message}`)
}
/** Assert a call is refused with a specific code. */
const refused = async (
  label: string,
  code: string,
  f: (c: Client) => Effect.Effect<unknown, unknown>,
) => {
  const got = await failCode(f)
  ok(label, got === code, got === null ? "SUCCEEDED" : got)
}

interface Concept {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly singleRecord: boolean
}
interface Field {
  readonly id: string
  readonly name: string
}
interface RecordVersion {
  readonly id: string
  readonly recordId: string
  readonly version: number
  readonly versionSeq: number
  readonly state: Record<string, unknown>
}

const newConcept = (name: string) =>
  call((c) => c.createConcept({ name })) as unknown as Promise<Concept>
const addField = (conceptId: string, name: string, kind = "text", config = {}) =>
  call((c) => c.addField({ conceptId, name, kind, config } as never)) as unknown as Promise<Field>
const toggle = (conceptId: string, singleRecord: boolean, fields?: Record<string, unknown>) =>
  call((c) =>
    c.setConceptSingleRecord({ conceptId, singleRecord, fields }),
  ) as unknown as Promise<Concept>
const getRecord = (conceptId: string) =>
  call((c) => c.getSingleRecord({ conceptId })) as unknown as Promise<{
    recordVersion: RecordVersion
    concept: Concept
    fields: ReadonlyArray<Field>
  } | null>
const listItems = (conceptId: string) =>
  call((c) => c.listRecords({ conceptId })) as unknown as Promise<ReadonlyArray<RecordVersion>>
const conceptsNow = () =>
  call((c) => c.listConcepts({ includeArchived: true })) as unknown as Promise<
    ReadonlyArray<Concept>
  >
const flagOf = async (id: string) => (await conceptsNow()).find((c) => c.id === id)?.singleRecord

// ══ slices 3+5: toggle on, no required fields ══════════════════════════════════
console.log("\n── toggle on (no required fields) ──")
const plain = await newConcept(`Company ${Date.now()}`)
const notes = await addField(plain.id, "Notes", "richtext")
ok("a new concept is many-record by default", plain.singleRecord === false)
ok("…with no records", (await listItems(plain.id)).length === 0)

const toggled = await toggle(plain.id, true)
ok("toggle on sets the flag", toggled.singleRecord === true)
const created = await listItems(plain.id)
ok("toggle on created the one record, atomically", created.length === 1, `n=${created.length}`)
await toggle(plain.id, true)
ok("re-toggling on is idempotent (no second record)", (await listItems(plain.id)).length === 1)

// ══ slice 6: /c/<slug> resolution ══════════════════════════════════════════════
console.log("\n── /c/<slug> resolution ──")
const detail = await getRecord(plain.id)
ok("getSingleRecord returns the record", !!detail && detail.recordVersion.id === created[0]?.id)
ok("…in getRecord's shape (concept + fields alongside)", !!detail?.concept && !!detail?.fields)
ok("…carrying the slug the route matches on", !!detail?.concept.slug, detail?.concept.slug)
ok(
  "…and the fields the record view renders",
  (detail?.fields ?? []).some((f) => f.id === notes.id),
)

// Null means "no live lineage", which is the leak detector: impossible while the
// flag is on. Note it does NOT consult the flag — resolution is defined on the
// oldest live lineage, and gating `/c/<slug>` on `singleRecord` is `conceptBySlug`'s
// job client-side (covered by sidebarViews.test.ts). Asserting a null here for a
// flagless concept would be asserting the wrong contract.
const empty = await newConcept(`Vendor ${Date.now()}`)
await addField(empty.id, "Name")
ok(
  "getSingleRecord is null when the concept has no records at all",
  (await getRecord(empty.id)) === null,
)
await call((c) => c.createRecord({ conceptId: empty.id, fields: {} }))
ok("…and resolves the lineage once one exists", (await getRecord(empty.id)) !== null)

// ══ slice 3: the guards behind slice 10's hidden affordances ═══════════════════
console.log("\n── guards (what the UI hides) ──")
const rec = created[0]!
await refused("create: a second record is refused", "SINGLE_RECORD_CONFLICT", (c) =>
  c.createRecord({ conceptId: plain.id, fields: {} }),
)
await refused("archive: the record can't be archived", "SINGLE_RECORD_PROTECTED", (c) =>
  c.archiveRecordVersion({ id: rec.id, expectedVersion: rec.version }),
)
await refused("purge: the record can't be deleted", "SINGLE_RECORD_PROTECTED", (c) =>
  c.deleteRecordVersion({ id: rec.id }),
)
await refused("archiveRecord: the lineage can't be archived", "SINGLE_RECORD_PROTECTED", (c) =>
  c.archiveRecord({ recordId: rec.recordId }),
)
ok("the record survived all four refusals", (await listItems(plain.id)).length === 1)

// ══ slice 5: toggle on WITH required fields ════════════════════════════════════
console.log("\n── toggle on (required fields) ──")
const strict = await newConcept(`Settings ${Date.now()}`)
const orgName = await addField(strict.id, "Org name", "text", { requirement: "required" })
// No `fields` → `create`'s ordinary checkRequired fails → the WHOLE toggle rolls
// back. This is the transaction claim: a leaked flag would leave a single-record
// concept with no record at all, which nothing downstream can recover from.
await refused("toggle on without the required value is refused", "VALIDATION", (c) =>
  c.setConceptSingleRecord({ conceptId: strict.id, singleRecord: true }),
)
ok("…and the flag rolled back with it", (await flagOf(strict.id)) === false)
ok("…leaving no record behind", (await listItems(strict.id)).length === 0)

const seeded = await toggle(strict.id, true, { [orgName.id]: "Acme Inc" })
ok("toggle on WITH the value succeeds", seeded.singleRecord === true)
const seededRec = await getRecord(strict.id)
ok(
  "…and the seed landed on the record",
  seededRec?.recordVersion.state[orgName.id] === "Acme Inc",
  JSON.stringify(seededRec?.recordVersion.state),
)

// ══ slice 3: composes with versioning (RECORD-level, not record version-level) ═════════
console.log("\n── versioned single record ──")
const versioned = await newConcept(`Playbook ${Date.now()}`)
await addField(versioned.id, "Body", "richtext")
await call((c) => c.updateConcept({ id: versioned.id, description: null, versioningEnabled: true }))
await toggle(versioned.id, true)
// A versioned concept's brand-new record is an unpublished DRAFT, invisible to
// every head-only query — precisely why resolution is `singleRecordOf`.
const vDetail = await getRecord(versioned.id)
ok("a versioned single record resolves while still a draft", !!vDetail)
const vRec = vDetail!.recordVersion
await refused(
  "discardDraft: the only-ever draft can't be discarded",
  "SINGLE_RECORD_PROTECTED",
  (c) => c.discardDraft({ id: vRec.id }),
)
await call((c) => c.publishVersion({ id: vRec.id, expectedVersion: vRec.version }))
const v2 = (await call((c) =>
  c.newVersion({ recordId: vRec.recordId }),
)) as unknown as RecordVersion
await call((c) => c.publishVersion({ id: v2.id, expectedVersion: v2.version }))
const versions = (await call((c) =>
  c.listVersions({ recordId: vRec.recordId }),
)) as unknown as ReadonlyArray<RecordVersion>
ok("the lineage legitimately holds N versions", versions.length === 2, `n=${versions.length}`)
ok("…and it is still ONE record", (await listItems(versioned.id)).length === 1)
ok(
  "…with the head resolving as the single record",
  (await getRecord(versioned.id))?.recordVersion.id === v2.id,
)

// ══ slice 3: toggle on with 2 live records is refused ══════════════════════════
const crowded = await newConcept(`Crowded ${Date.now()}`)
await addField(crowded.id, "Name")
await call((c) => c.createRecord({ conceptId: crowded.id, fields: {} }))
await call((c) => c.createRecord({ conceptId: crowded.id, fields: {} }))
await refused(
  "toggle on with 2 live records is refused (which one would be 'the' one?)",
  "SINGLE_RECORD_CONFLICT",
  (c) => c.setConceptSingleRecord({ conceptId: crowded.id, singleRecord: true }),
)
ok("…and the flag stayed off", (await flagOf(crowded.id)) === false)

// ══ slice 3: toggle OFF releases the record (the documented way out) ═══════════
console.log("\n── toggle off ──")
const released = await toggle(plain.id, false)
ok("toggle off clears the flag", released.singleRecord === false)
const relRec = (await listItems(plain.id))[0]!
ok("…and the record stays, as an ordinary record", !!relRec)
const archived = (await call((c) =>
  c.archiveRecordVersion({ id: relRec.id, expectedVersion: relRec.version }),
)) as unknown as RecordVersion
ok("…now archivable like any other", (await listItems(plain.id)).length === 0)
await call((c) => c.restoreRecordVersion({ id: archived.id, expectedVersion: archived.version }))
ok("…and restorable", (await listItems(plain.id)).length === 1)
await toggle(plain.id, true)
ok("toggling back on reuses the existing record", (await listItems(plain.id)).length === 1)

// ══ slice 7: sidebar concept:<id> entries ══════════════════════════════════════
console.log("\n── sidebar entry ──")
const views = (await call((c) => c.listViews())) as unknown as ReadonlyArray<{
  id: string
  body: {
    sections: ReadonlyArray<{
      id: string
      title: string | null
      icon: string | null
      entryIds: ReadonlyArray<string>
    }>
  }
}>
const view = views[0]
if (!view) {
  ok("a sidebar view exists to place the entry in", false, "no views seeded")
} else {
  const entry = `concept:${plain.id}`
  const sections = view.body.sections
  const nextSections = sections.length
    ? [{ ...sections[0]!, entryIds: [...sections[0]!.entryIds, entry] }, ...sections.slice(1)]
    : [{ id: "s1", title: "Records", icon: null, entryIds: [entry] }]
  const saved = (await call((c) =>
    c.updateView({ id: view.id, body: { sections: nextSections } as never }),
  )) as unknown as { body: { sections: ReadonlyArray<{ entryIds: ReadonlyArray<string> }> } }
  ok(
    "a sidebar section accepts a concept:<id> entry",
    saved.body.sections.some((s) => s.entryIds.includes(entry)),
  )
  const reread = (await call((c) => c.listViews())) as unknown as ReadonlyArray<{
    id: string
    body: { sections: ReadonlyArray<{ entryIds: ReadonlyArray<string> }> }
  }>
  ok(
    "…and it survives a re-read (so the sidebar renders it)",
    !!reread.find((v) => v.id === view.id)?.body.sections.some((s) => s.entryIds.includes(entry)),
  )
}

// ══ slice 8: widget binding round-trips ════════════════════════════════════════
console.log("\n── widget binding ──")
const dash = (await call((c) =>
  c.createDashboard({
    name: `SR Page ${Date.now()}`,
    scope: "org",
    body: {
      direction: "col",
      children: [
        {
          id: "w1",
          type: "document",
          title: "Company doc",
          conceptId: plain.id,
          fieldId: notes.id,
          bindToConceptRecord: true,
        },
      ],
    } as never,
  }),
)) as unknown as { id: string; body: { children: ReadonlyArray<Record<string, unknown>> } }
const widget = dash.body.children?.[0]
ok("bindToConceptRecord survives the dashboard round-trip", widget?.bindToConceptRecord === true)
ok(
  "…alongside its concept + field refs",
  widget?.conceptId === plain.id && widget?.fieldId === notes.id,
)
// The canvas resolves a bound widget through this very call, so proving it points
// at the same lineage `/c/<slug>` shows is what "edits the same record" means.
const bound = await getRecord(plain.id)
ok(
  "the bound widget and /c/<slug> resolve the SAME record",
  !!bound && bound.recordVersion.recordId === relRec.recordId,
  `${bound?.recordVersion.recordId} vs ${relRec.recordId}`,
)

// ══ slice 9: concept delete cascades to the record ═════════════════════════════
console.log("\n── concept delete cascade ──")
const doomed = await newConcept(`Doomed ${Date.now()}`)
await addField(doomed.id, "Name")
await toggle(doomed.id, true)
const doomedRec = (await listItems(doomed.id))[0]!
await call((c) => c.deleteConcept({ id: doomed.id }))
ok(
  "deleting a single-record concept succeeds",
  !(await conceptsNow()).some((c) => c.id === doomed.id),
)
await refused("…and takes its record with it", "NOT_FOUND", (c) =>
  c.getRecord({ id: doomedRec.id }),
)

// The versioned case exercises the newest-first loop: a leftover sibling version
// would leave an orphaned lineage and make `ConceptInUse` refuse the purge.
const doomedV = await newConcept(`DoomedV ${Date.now()}`)
await addField(doomedV.id, "Name")
await call((c) => c.updateConcept({ id: doomedV.id, description: null, versioningEnabled: true }))
await toggle(doomedV.id, true)
const dv1 = (await getRecord(doomedV.id))!.recordVersion
await call((c) => c.publishVersion({ id: dv1.id, expectedVersion: dv1.version }))
const dv2 = (await call((c) =>
  c.newVersion({ recordId: dv1.recordId }),
)) as unknown as RecordVersion
await call((c) => c.publishVersion({ id: dv2.id, expectedVersion: dv2.version }))
await call((c) => c.deleteConcept({ id: doomedV.id }))
ok(
  "deleting a VERSIONED single-record concept succeeds",
  !(await conceptsNow()).some((c) => c.id === doomedV.id),
)
await refused("…purging the head", "NOT_FOUND", (c) => c.getRecord({ id: dv2.id }))
await refused("…and the earlier version too", "NOT_FOUND", (c) => c.getRecord({ id: dv1.id }))

// A live relation pointing at the record is NOT forced through — orphaning it is
// exactly what the archive/delete convention exists to prevent.
const held = await newConcept(`Held ${Date.now()}`)
await addField(held.id, "Name")
await toggle(held.id, true)
const holder = await newConcept(`Holder ${Date.now()}`)
const relField = (await call((c) =>
  c.addField({
    conceptId: holder.id,
    name: "Held ref",
    kind: "relation",
    config: { target: held.id, cardinality: "one" },
  } as never),
)) as unknown as Field
const holderInst = (await call((c) =>
  c.createRecord({ conceptId: holder.id, fields: {} }),
)) as unknown as RecordVersion
const heldRec = (await getRecord(held.id))!.recordVersion
await call((c) =>
  c.createRelation({ fieldId: relField.id, fromId: holderInst.id, toRecordId: heldRec.recordId }),
)
await refused(
  "a referenced record blocks the cascade rather than orphaning the edge",
  "INSTANCE_IN_USE",
  (c) => c.deleteConcept({ id: held.id }),
)
ok("…and the whole transaction rolled back: flag still on", (await flagOf(held.id)) === true)
ok("…record still there", (await listItems(held.id)).length === 1)

await runtime.dispose()
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
