import { randomUUID } from "node:crypto"
import type { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  ConceptService,
  type EngineServices,
  FieldService,
  InstanceService,
  type OrgContext,
} from "#engine"
import { runEngine, runEngineOrThrow, systemScope } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import * as uc from "./use-cases"
import {
  addField,
  archiveConcept,
  archiveField,
  archiveInstance,
  archiveLabel,
  createConcept,
  createInstance,
  createLabel,
  deleteConcept,
  deleteField,
  deleteInstance,
  deleteLabel,
  getChanged,
  getConceptGraph,
  getGraphLayout,
  getInstanceDetail,
  getInstanceGraphLayout,
  getInstanceViewPrefs,
  getSingleRecord,
  linkRelation,
  listConcepts,
  listFields,
  listInstances,
  listLabels,
  listVersions,
  newVersion,
  publishVersion,
  restoreConcept,
  restoreField,
  restoreInstance,
  restoreLabel,
  saveGraphLayout,
  saveInstanceGraphLayout,
  setConceptSingleRecord,
  updateField,
  updateInstance,
  updateInstanceViewPrefs,
} from "./use-cases"

type WithId = { readonly id: string }
type Archivable = {
  readonly id: string
  readonly archivedAt: Date | null
  readonly version: number
}
const ids = (xs: unknown) => (xs as ReadonlyArray<WithId>).map((x) => x.id)
const has = (xs: unknown, id: string) => ids(xs).includes(id)

// `PgClient` because a use-case may own its own transaction (`deleteConcept`'s
// single-record cascade); the runtime surfaces it either way.
const run = <A, E>(
  orgId: string,
  eff: Effect.Effect<A, E, OrgContext | EngineServices | PgClient.PgClient>,
) => runEngineOrThrow(systemScope(orgId, "system"), eff)

/** The error code of a (failed) use-case result; undefined on success. */
const codeOf = (r: { readonly ok: boolean; readonly code?: string }) => (r.ok ? undefined : r.code)

type FieldRow = { id: string; name: string; kind: string }

describe("use-cases (UI backbone)", () => {
  it("builds a graph from generic primitives, keyed by field id, and surfaces it", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // The app identifies concepts + fields by id; resolve seeded names → ids.
    const concepts = (await run(org, listConcepts())) as ReadonlyArray<{ id: string; name: string }>
    const idOf = (name: string) => concepts.find((c) => c.name === name)!.id

    const fieldsOf = async (conceptId: string) =>
      (await run(org, listFields(conceptId))) as ReadonlyArray<FieldRow>
    const fieldId = (fields: ReadonlyArray<FieldRow>, name: string) =>
      fields.find((f) => f.name === name)!.id

    const companyFields = await fieldsOf(idOf("Company"))
    const contactFields = await fieldsOf(idOf("CompanyContact"))
    const worksAt = fieldId(contactFields, "works_at")

    // Create instances with field-id-keyed state (names are just labels now).
    const company = await run(
      org,
      createInstance(idOf("Company"), { [fieldId(companyFields, "name")]: "Acme" }),
    )
    const contact = await run(
      org,
      createInstance(idOf("CompanyContact"), {
        [fieldId(contactFields, "name")]: "Jane",
        [fieldId(contactFields, "email")]: "jane@acme.com",
      }),
    )

    // Link via the relation field's id (not a type string).
    await run(org, linkRelation(worksAt, contact.id, company.id))

    // The contact's detail view resolves the connected Company, labelled by the
    // relation field's (renameable) name and the target's display label.
    const detail = (await run(org, getInstanceDetail(contact.id))) as {
      related: ReadonlyArray<{
        relationName: string
        label: string
        conceptName: string
        direction: "out" | "in"
        fieldId: string
      }>
    }
    expect(detail.related.length).toBe(1)
    const edge = detail.related[0]!
    expect(edge.fieldId).toBe(worksAt)
    expect(edge.relationName).toBe("works_at")
    expect(edge.label).toBe("Acme")
    expect(edge.conceptName).toBe("Company")
    expect(edge.direction).toBe("out")

    // The concept graph exposes the same relation as a typed edge (by field id).
    const graph = (await run(org, getConceptGraph)) as {
      edges: ReadonlyArray<{ id: string; from: string; to: string; fieldName: string }>
    }
    expect(
      graph.edges.some(
        (e) => e.id === worksAt && e.from === idOf("CompanyContact") && e.to === idOf("Company"),
      ),
    ).toBe(true)

    // "What changed": events recorded across the workflow.
    const changed = (await run(org, getChanged)) as ReadonlyArray<unknown>
    expect(changed.length).toBeGreaterThan(2)

    // Inverse naming: the company side of the same edge heads with the field's
    // inverse labels, and the company's detail lists works_at as inbound-addable.
    await run(
      org,
      updateField({
        id: worksAt,
        config: {
          target: idOf("Company"),
          inverseName: "Employee",
          inversePluralName: "Employees",
        },
      }),
    )
    const companyDetail = (await run(org, getInstanceDetail(company.id))) as {
      related: ReadonlyArray<{
        direction: "out" | "in"
        relationInverseName: string | null
        relationInversePluralName: string | null
      }>
      inboundRelationFields: ReadonlyArray<{ id: string }>
    }
    expect(companyDetail.related.length).toBe(1)
    const inEdge = companyDetail.related[0]!
    expect(inEdge.direction).toBe("in")
    expect(inEdge.relationInverseName).toBe("Employee")
    expect(inEdge.relationInversePluralName).toBe("Employees")
    expect(companyDetail.inboundRelationFields.map((f) => f.id)).toContain(worksAt)
  })
})

describe("archive / restore / delete (end-to-end use-case wiring)", () => {
  it("concepts: archive hides, restore brings back, withCounts reports, delete removes", async () => {
    const org = randomUUID()
    const c = (await run(org, createConcept("Widget"))) as WithId

    expect(has(await run(org, listConcepts()), c.id)).toBe(true)
    await run(org, archiveConcept(c.id))
    expect(has(await run(org, listConcepts()), c.id)).toBe(false)
    const archived = (await run(org, listConcepts(true))) as ReadonlyArray<Archivable>
    expect(archived.find((x) => x.id === c.id)?.archivedAt).not.toBeNull()

    await run(org, restoreConcept(c.id))
    expect(has(await run(org, listConcepts()), c.id)).toBe(true)

    const counted = (await run(org, listConcepts(true, true))) as ReadonlyArray<
      WithId & { itemCount?: number }
    >
    expect(counted.find((x) => x.id === c.id)?.itemCount).toBe(0)

    await run(org, deleteConcept(c.id))
    expect(has(await run(org, listConcepts(true)), c.id)).toBe(false)
  })

  it("fields: archive/restore round-trip then hard delete", async () => {
    const org = randomUUID()
    const c = (await run(org, createConcept("Gadget"))) as WithId
    const f = (await run(org, addField({ conceptId: c.id, name: "note", kind: "text" }))) as WithId

    await run(org, archiveField(f.id))
    expect(has(await run(org, listFields(c.id)), f.id)).toBe(false)
    expect(has(await run(org, listFields(c.id, true)), f.id)).toBe(true)
    await run(org, restoreField(f.id))
    expect(has(await run(org, listFields(c.id)), f.id)).toBe(true)
    await run(org, deleteField(f.id))
    expect(has(await run(org, listFields(c.id, true)), f.id)).toBe(false)
  })

  it("labels: archive/restore round-trip then hard delete", async () => {
    const org = randomUUID()
    const l = (await run(org, createLabel("Hot"))) as WithId

    await run(org, archiveLabel(l.id))
    expect(has(await run(org, listLabels()), l.id)).toBe(false)
    await run(org, restoreLabel(l.id))
    expect(has(await run(org, listLabels()), l.id)).toBe(true)
    await run(org, deleteLabel(l.id))
    expect(has(await run(org, listLabels(true)), l.id)).toBe(false)
  })

  it("instances: archive/restore round-trip, concept purge blocked until items cleared", async () => {
    const org = randomUUID()
    const c = (await run(org, createConcept("Lead"))) as WithId
    const inst = (await run(org, createInstance(c.id, {}))) as Archivable

    const archived = (await run(org, archiveInstance(inst.id, inst.version))) as Archivable
    expect(archived.archivedAt).not.toBeNull()
    expect(has(await run(org, listInstances(c.id)), inst.id)).toBe(false)
    expect(has(await run(org, listInstances(c.id, { includeArchived: true })), inst.id)).toBe(true)

    // A concept with any item (even archived) refuses a hard delete. The thrown
    // ConceptInUse serialises as its fields, so match the distinctive instanceCount.
    await expect(run(org, deleteConcept(c.id))).rejects.toThrow(/instanceCount/)

    await run(org, restoreInstance(inst.id, archived.version))
    expect(has(await run(org, listInstances(c.id)), inst.id)).toBe(true)

    await run(org, deleteInstance(inst.id))
    expect(has(await run(org, listInstances(c.id, { includeArchived: true })), inst.id)).toBe(false)
    // Now empty, the concept deletes cleanly.
    await run(org, deleteConcept(c.id))
    expect(has(await run(org, listConcepts(true)), c.id)).toBe(false)
  })
})

describe("concept graph layout (shared canvas positions)", () => {
  it("merges patches per node, prunes unknown ids, and stays org-scoped", async () => {
    const orgA = randomUUID()
    const orgB = randomUUID()
    const a = (await run(orgA, createConcept("Alpha"))) as WithId
    const b = (await run(orgA, createConcept("Beta"))) as WithId

    // Empty before anything is saved.
    expect(await run(orgA, getGraphLayout)).toEqual({})

    // First patch inserts.
    await run(orgA, saveGraphLayout({ [a.id]: { x: 10, y: 20 } }))
    expect(await run(orgA, getGraphLayout)).toEqual({ [a.id]: { x: 10, y: 20 } })

    // A later patch for a DIFFERENT node merges instead of clobbering — two
    // editors moving different nodes both keep their changes.
    await run(orgA, saveGraphLayout({ [b.id]: { x: -5.5, y: 0 } }))
    expect(await run(orgA, getGraphLayout)).toEqual({
      [a.id]: { x: 10, y: 20 },
      [b.id]: { x: -5.5, y: 0 },
    })

    // Same node: last write wins per node.
    await run(orgA, saveGraphLayout({ [a.id]: { x: 300, y: 400 } }))
    expect((await run(orgA, getGraphLayout)) as Record<string, unknown>).toMatchObject({
      [a.id]: { x: 300, y: 400 },
      [b.id]: { x: -5.5, y: 0 },
    })

    // Ids that aren't this org's concepts are pruned (validation + GC).
    await run(orgA, saveGraphLayout({ [randomUUID()]: { x: 1, y: 1 } }))
    expect(Object.keys((await run(orgA, getGraphLayout)) as object).sort()).toEqual(
      [a.id, b.id].sort(),
    )

    // Hard-deleting a concept washes its entry out on the next save.
    await run(orgA, deleteConcept(b.id))
    await run(orgA, saveGraphLayout({ [a.id]: { x: 1, y: 2 } }))
    expect(await run(orgA, getGraphLayout)).toEqual({ [a.id]: { x: 1, y: 2 } })

    // Other orgs never see it.
    expect(await run(orgB, getGraphLayout)).toEqual({})
  })

  it("instance graph layouts: per-item rows, merge per node, ghost keys survive pruning", async () => {
    const org = randomUUID()
    const c = (await run(org, createConcept("Person"))) as WithId
    const a = (await run(org, createInstance(c.id, {}))) as { itemId: string }
    const b = (await run(org, createInstance(c.id, {}))) as { itemId: string }

    // Empty before anything is saved; rows are keyed by the ROOT item.
    expect(await run(org, getInstanceGraphLayout(a.itemId))).toEqual({})

    // Patches merge per node; ghost keys (dangling refs) are kept, foreign ids pruned.
    await run(org, saveInstanceGraphLayout(a.itemId, { [a.itemId]: { x: 1, y: 2 } }))
    await run(
      org,
      saveInstanceGraphLayout(a.itemId, {
        [b.itemId]: { x: 3, y: 4 },
        "ghost:some-relation": { x: 5, y: 6 },
        [randomUUID()]: { x: 9, y: 9 },
      }),
    )
    expect(await run(org, getInstanceGraphLayout(a.itemId))).toEqual({
      [a.itemId]: { x: 1, y: 2 },
      [b.itemId]: { x: 3, y: 4 },
      "ghost:some-relation": { x: 5, y: 6 },
    })

    // A different root item has its own independent layout.
    expect(await run(org, getInstanceGraphLayout(b.itemId))).toEqual({})
  })
})

describe("instance view prefs", () => {
  it("reads defaults for a fresh user, then upserts the caller's own row", async () => {
    const orgA = randomUUID()
    const orgB = randomUUID()
    const empty = { defaultView: null, byConcept: {}, customByConcept: {} }

    // Never saved: a well-formed empty body, no row created.
    expect(await run(orgA, getInstanceViewPrefs)).toEqual({ userId: "system", body: empty })

    // Preset override + a custom tile layout + a graph config round-trip verbatim.
    const conceptId = randomUUID()
    const layout = {
      tiles: [{ id: "a", contents: ["details", "notes"], x: 0, y: 0, w: 8, h: 4 }],
    }
    const graphConfig = { fieldIds: null, depth: 3, layout: "dagre-tb" }
    const saved = await run(
      orgA,
      updateInstanceViewPrefs({
        defaultView: "document",
        byConcept: { [conceptId]: "custom" },
        customByConcept: { [conceptId]: layout },
        graphByConcept: { [conceptId]: graphConfig },
      }),
    )
    expect(saved).toEqual({
      userId: "system",
      body: {
        defaultView: "document",
        byConcept: { [conceptId]: "custom" },
        customByConcept: { [conceptId]: layout },
        graphByConcept: { [conceptId]: graphConfig },
      },
    })

    // Second write hits the same (org, user) row — an upsert, not a new row.
    // Stored rows read back with every section present (graphByConcept fills in).
    await run(orgA, updateInstanceViewPrefs(empty))
    expect(await run(orgA, getInstanceViewPrefs)).toEqual({
      userId: "system",
      body: { ...empty, graphByConcept: {} },
    })

    // Prefs are org-scoped: the other org still reads defaults.
    expect(await run(orgB, getInstanceViewPrefs)).toEqual({ userId: "system", body: empty })
  })
})

describe("managed concepts: field-level read-only guard", () => {
  it("locks synced fields + record lifecycle, but allows user fields + their values", async () => {
    const org = randomUUID()
    const scope = systemScope(org, "u")
    await run(org, seedKingsmaker)

    // Simulate a connector sync: a managed concept + one integration-owned field
    // (the sync path goes straight through the engine, bypassing the guard).
    const concept = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.create({ name: "Email", managedBy: "google.gmail" })),
    )
    const synced = await run(
      org,
      Effect.flatMap(FieldService, (f) =>
        f.addField({
          conceptId: concept.id,
          name: "Subject",
          kind: "text",
          managedBy: "google.gmail",
        }),
      ),
    )
    expect(synced.managedBy).toBe("google.gmail")

    // A member adds their OWN field — allowed on a managed concept; stays unmanaged.
    const userField = (await run(
      org,
      addField({
        conceptId: concept.id,
        name: "Status",
        kind: "enum",
        config: { options: ["new", "done"] },
      }),
    )) as { id: string; managedBy: string | null }
    expect(userField.managedBy).toBeNull()

    // Schema edits: synced field locked, user field editable.
    expect(codeOf(await runEngine(scope, updateField({ id: synced.id, name: "Renamed" })))).toBe(
      "MANAGED_READONLY",
    )
    expect((await runEngine(scope, updateField({ id: userField.id, name: "State" }))).ok).toBe(true)
    expect(codeOf(await runEngine(scope, archiveField(synced.id)))).toBe("MANAGED_READONLY")
    // A throwaway user field archives fine (don't archive the one used below).
    const extra = (await run(
      org,
      addField({ conceptId: concept.id, name: "Extra", kind: "text" }),
    )) as WithId
    expect((await runEngine(scope, archiveField(extra.id))).ok).toBe(true)

    // A synced record (created by the sync path).
    const inst = await run(
      org,
      Effect.flatMap(InstanceService, (i) =>
        i.create({ conceptId: concept.id, fields: { [synced.id]: "Hello" } }),
      ),
    )

    // Value writes: a member may set their own field, but not a synced one.
    expect(
      (await runEngine(scope, updateInstance(inst.id, inst.version, { [userField.id]: "new" }))).ok,
    ).toBe(true)
    expect(
      codeOf(
        await runEngine(scope, updateInstance(inst.id, inst.version, { [synced.id]: "tampered" })),
      ),
    ).toBe("MANAGED_READONLY")

    // Record lifecycle stays integration-owned.
    expect(codeOf(await runEngine(scope, createInstance(concept.id, {})))).toBe("MANAGED_READONLY")
    expect(codeOf(await runEngine(scope, deleteInstance(inst.id)))).toBe("MANAGED_READONLY")
  })

  it("leaves unmanaged concepts fully editable (no false positives)", async () => {
    const org = randomUUID()
    const scope = systemScope(org, "u")
    await run(org, seedKingsmaker)

    const concept = (await run(org, createConcept("Widget"))) as WithId
    const field = (await run(
      org,
      addField({ conceptId: concept.id, name: "Note", kind: "text" }),
    )) as WithId
    const inst = (await run(org, createInstance(concept.id, { [field.id]: "x" }))) as {
      id: string
      version: number
    }

    expect((await runEngine(scope, updateField({ id: field.id, name: "Notes" }))).ok).toBe(true)
    expect(
      (await runEngine(scope, updateInstance(inst.id, inst.version, { [field.id]: "y" }))).ok,
    ).toBe(true)
    expect((await runEngine(scope, deleteInstance(inst.id))).ok).toBe(true)
  })
})

// The engine's own guards are covered in packages/engine's single-record suite;
// these cover what only exists at THIS layer: the managed-concept gate, the
// ERROR_MAP wiring, and `getSingleRecord` returning the shared
// `getInstanceDetail` shape.
describe("single-record concepts (use-case layer)", () => {
  it("toggling single-record on creates the record and resolves it with full detail", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    const concept = (await run(org, createConcept("Org Profile"))) as WithId
    const field = (await run(
      org,
      addField({ conceptId: concept.id, name: "Mission", kind: "text" }),
    )) as WithId

    // No record before the toggle.
    expect(await run(org, getSingleRecord(concept.id))).toBeNull()

    const flipped = (await run(
      org,
      setConceptSingleRecord(concept.id, true, { [field.id]: "Ship it" }),
    )) as { singleRecord: boolean }
    expect(flipped.singleRecord).toBe(true)

    // Resolves as the SAME shape getInstance returns (concept + field defs +
    // related + labels), not a bespoke payload — that's what lets /c/<slug>
    // render through the ordinary record view.
    const detail = (await run(org, getSingleRecord(concept.id))) as {
      instance: { id: string; state: Record<string, unknown> }
      concept: { id: string; singleRecord: boolean }
      fields: ReadonlyArray<FieldRow>
      related: ReadonlyArray<unknown>
      staticLabels: ReadonlyArray<unknown>
      labels: ReadonlyArray<unknown>
    }
    expect(detail.concept.id).toBe(concept.id)
    expect(detail.concept.singleRecord).toBe(true)
    expect(detail.instance.state[field.id]).toBe("Ship it")
    expect(ids(detail.fields)).toContain(field.id)
    expect(detail.related).toEqual([])
    expect(detail.staticLabels).toEqual([])
    expect(detail.labels).toEqual([])

    // Same id as the detail route would fetch directly.
    const direct = (await run(org, getInstanceDetail(detail.instance.id))) as {
      instance: { id: string }
    }
    expect(direct.instance.id).toBe(detail.instance.id)

    // Turning it back off leaves the record in place as an ordinary record.
    const off = (await run(org, setConceptSingleRecord(concept.id, false))) as {
      singleRecord: boolean
    }
    expect(off.singleRecord).toBe(false)
    expect(ids(await run(org, listInstances(concept.id)))).toContain(detail.instance.id)
  })

  it("resolves a VERSIONED concept's record while it is still an unpublished draft", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // The regression this guards: a draft is invisible to every head-only query,
    // so a naive listInstances[0] resolution renders "no record" for the very
    // first state of every versioned single-record concept.
    const concept = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.create({ name: "Charter" })),
    )
    await run(
      org,
      Effect.flatMap(ConceptService, (c) =>
        c.update({ id: concept.id, description: null, versioningEnabled: true }),
      ),
    )
    await run(org, setConceptSingleRecord(concept.id, true))

    // Head-only listing sees nothing...
    expect(ids(await run(org, listInstances(concept.id)))).toEqual([])
    // ...but the record plainly exists and resolves.
    const detail = (await run(org, getSingleRecord(concept.id))) as {
      instance: { versionStatus: string }
    } | null
    expect(detail).not.toBeNull()
    expect(detail!.instance.versionStatus).toBe("draft")
  })

  it("refuses the toggle on a managed concept (the integration owns its records)", async () => {
    const org = randomUUID()
    const scope = systemScope(org, "u")
    await run(org, seedKingsmaker)

    const concept = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.create({ name: "Email", managedBy: "google.gmail" })),
    )
    expect(codeOf(await runEngine(scope, setConceptSingleRecord(concept.id, true)))).toBe(
      "MANAGED_READONLY",
    )
    // And the refusal left no record behind.
    expect(await run(org, getSingleRecord(concept.id))).toBeNull()
  })

  it("surfaces SINGLE_RECORD_CONFLICT (not a 500) when the concept already has two records", async () => {
    const org = randomUUID()
    const scope = systemScope(org, "u")
    await run(org, seedKingsmaker)

    const concept = (await run(org, createConcept("Team"))) as WithId
    await run(org, createInstance(concept.id, {}))
    await run(org, createInstance(concept.id, {}))

    // Guards the ERROR_MAP wiring: an unmapped _tag degrades to 500 silently.
    expect(codeOf(await runEngine(scope, setConceptSingleRecord(concept.id, true)))).toBe(
      "SINGLE_RECORD_CONFLICT",
    )
  })

  it("rolls the flag back when a required field is missing from the toggle payload", async () => {
    const org = randomUUID()
    const scope = systemScope(org, "u")
    await run(org, seedKingsmaker)

    const concept = (await run(org, createConcept("Settings"))) as WithId
    await run(
      org,
      addField({
        conceptId: concept.id,
        name: "Owner",
        kind: "text",
        config: { requirement: "required" },
      }),
    )

    const flagOf = async () => {
      const all = (await run(org, listConcepts())) as ReadonlyArray<{
        id: string
        singleRecord: boolean
      }>
      return all.find((c) => c.id === concept.id)!.singleRecord
    }
    const owner = (await run(org, listFields(concept.id))) as ReadonlyArray<FieldRow>
    const ownerId = owner.find((f) => f.name === "Owner")!.id

    // Server-enforced, so "Cancel" in the modal can't be worked around: the
    // record creation fails checkRequired and takes the flag flip down with it.
    expect(codeOf(await runEngine(scope, setConceptSingleRecord(concept.id, true)))).toBe(
      "VALIDATION",
    )
    expect(await flagOf()).toBe(false)
    expect(await run(org, getSingleRecord(concept.id))).toBeNull()

    // Same call, same concept, values supplied → succeeds. This half is what
    // makes the half above meaningful: it proves the rejection came from the
    // missing value, not from the toggle being broken for this concept outright
    // (a bug that would leave the assertions above passing vacuously).
    expect(
      (await runEngine(scope, setConceptSingleRecord(concept.id, true, { [ownerId]: "Kalle" }))).ok,
    ).toBe(true)
    expect(await flagOf()).toBe(true)
    const detail = (await run(org, getSingleRecord(concept.id))) as {
      instance: { state: Record<string, unknown> }
    } | null
    expect(detail!.instance.state[ownerId]).toBe("Kalle")
  })

  // The cascade only exists here — `ConceptService.purge` still refuses on
  // `instanceCount > 0` (block, never cascade), and a single-record concept can
  // never reach zero records on its own. Without this, such a concept would be
  // undeletable forever.
  it("deleting a single-record concept takes its record with it", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    const concept = (await run(org, createConcept("Org Profile"))) as WithId
    await run(org, setConceptSingleRecord(concept.id, true))
    const detail = (await run(org, getSingleRecord(concept.id))) as { instance: WithId }
    const recordId = detail.instance.id

    await run(org, deleteConcept(concept.id))
    expect(has(await run(org, listConcepts(true)), concept.id)).toBe(false)
    // The record went with it — not left behind as an orphan pointing at a
    // concept that no longer exists.
    await expect(run(org, getInstanceDetail(recordId))).rejects.toThrow()
  })

  it("keeps the concept AND its record when a relation still points at the record", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // A relation into the sole record is exactly what block-never-cascade exists
    // to protect: forcing the delete through would orphan the edge. `InstanceInUse`
    // surfaces from the record purge and rolls the whole transaction back.
    const target = (await run(org, createConcept("Org Profile"))) as WithId
    await run(org, setConceptSingleRecord(target.id, true))
    const detail = (await run(org, getSingleRecord(target.id))) as { instance: WithId }

    const source = (await run(org, createConcept("Deal"))) as WithId
    const rel = (await run(
      org,
      addField({
        conceptId: source.id,
        name: "Profile",
        kind: "relation",
        config: { target: target.id },
      }),
    )) as WithId
    const deal = (await run(org, createInstance(source.id, {}))) as WithId
    await run(org, linkRelation(rel.id, deal.id, detail.instance.id))

    await expect(run(org, deleteConcept(target.id))).rejects.toThrow(/relationCount/)

    // Rolled back whole: the concept survives, the record survives, and — the
    // part a non-transactional composition would get wrong — the flag is still on
    // (step 1 cleared it before the purge failed at step 2).
    const after = (await run(org, listConcepts(true))) as ReadonlyArray<{
      id: string
      singleRecord: boolean
    }>
    expect(after.find((c) => c.id === target.id)?.singleRecord).toBe(true)
    expect(await run(org, getSingleRecord(target.id))).not.toBeNull()
  })

  it("deletes every version of the record, so a versioned concept purges too", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // A versioned lineage holds N instance rows for ONE record. Purging only the
    // resolved head would leave the others behind and `ConceptInUse` would refuse
    // — so the cascade walks the whole lineage.
    const concept = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.create({ name: "Charter" })),
    )
    await run(
      org,
      Effect.flatMap(ConceptService, (c) =>
        c.update({ id: concept.id, description: null, versioningEnabled: true }),
      ),
    )
    await run(org, setConceptSingleRecord(concept.id, true))
    const detail = (await run(org, getSingleRecord(concept.id))) as {
      instance: { id: string; itemId: string; version: number }
    }
    // Publish, then open a second version — two instance rows on one lineage.
    await run(org, publishVersion(detail.instance.id, detail.instance.version))
    await run(org, newVersion(detail.instance.itemId))
    expect((await run(org, listVersions(detail.instance.itemId))).length).toBe(2)

    await run(org, deleteConcept(concept.id))
    expect(has(await run(org, listConcepts(true)), concept.id)).toBe(false)
  })
})

/**
 * ── SUBJECT WRITE GATES ─────────────────────────────────────────────────────
 *
 * The annotation/attachment analogue of THE WRITE GATE (engine InstanceService).
 *
 * Every READ of a note, task, file or activity feed was gated through
 * `assertSubjectReadable`, because those tables carry no concept column. The three
 * paths that name a subject to WRITE it — `createNote`, `createTask`,
 * `uploadAttachment` — were not. A member could attach content to a record they
 * cannot see, and then be refused when reading it back.
 *
 * Found by probing after the instance-write hole, on the theory that "reads gated,
 * writes not" would repeat. It did, in three more places.
 */
describe("writes cannot name a subject the caller may not read", () => {
  const seedSealed = () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const sealed = yield* concepts.create({ name: `Sealed ${randomUUID().slice(0, 6)}` })
      const f = yield* fields.addField({ conceptId: sealed.id, name: "T", kind: "text" })
      const rec = yield* instances.create({ conceptId: sealed.id, fields: { [f.id]: "secret" } })
      const open = yield* concepts.create({ name: `Open ${randomUUID().slice(0, 6)}` })
      const openRec = yield* instances.create({ conceptId: open.id, fields: {} })
      yield* concepts.setVisibility(sealed.id, "admin")
      return { sealedItemId: rec.itemId, openItemId: openRec.itemId }
    })

  it("refuses a note, task or upload on a restricted record — but allows them on a visible one", async () => {
    const orgId = randomUUID()
    const f = await runEngineOrThrow(systemScope(orgId, "seed"), seedSealed())

    const asMember = <A>(eff: Effect.Effect<A, unknown, OrgContext | EngineServices>) =>
      runEngine({ orgId, actor: "intruder", role: "member" }, eff)

    // Restricted subject: all three writes refused.
    expect((await asMember(uc.createNote({ subjectId: f.sealedItemId, body: "x" }))).ok).toBe(false)
    expect((await asMember(uc.createTask({ subjectId: f.sealedItemId, title: "x" }))).ok).toBe(
      false,
    )
    expect(
      (
        await asMember(
          uc.uploadAttachment(
            { itemId: f.sealedItemId },
            "x.txt",
            "text/plain",
            new TextEncoder().encode("hi"),
          ),
        )
      ).ok,
    ).toBe(false)

    // NOTHING was planted — a refusal that still wrote would pass the assertions above.
    const notes = await runEngineOrThrow(systemScope(orgId, "seed"), uc.listNotes(f.sealedItemId))
    expect(notes).toHaveLength(0)

    // CONTROL: the same writes on a visible record must still succeed, or this fix
    // has broken ordinary note-taking for everyone.
    expect((await asMember(uc.createNote({ subjectId: f.openItemId, body: "ok" }))).ok).toBe(true)
    expect((await asMember(uc.createTask({ subjectId: f.openItemId, title: "ok" }))).ok).toBe(true)
    // CONTROL: an org-level annotation names no record, so it is never gated (the
    // global Tasks page creates these).
    expect((await asMember(uc.createNote({ subjectId: null, body: "ok" }))).ok).toBe(true)
  })
})
