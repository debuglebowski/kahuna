import { randomUUID } from "node:crypto"
import type { EngineServices, OrgContext } from "@kingsmaker/engine"
import type { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
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
  linkRelation,
  listConcepts,
  listFields,
  listInstances,
  listLabels,
  restoreConcept,
  restoreField,
  restoreInstance,
  restoreLabel,
  saveGraphLayout,
} from "./use-cases"

type WithId = { readonly id: string }
type Archivable = {
  readonly id: string
  readonly archivedAt: Date | null
  readonly version: number
}
const ids = (xs: unknown) => (xs as ReadonlyArray<WithId>).map((x) => x.id)
const has = (xs: unknown, id: string) => ids(xs).includes(id)

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow({ orgId, actor: "system" }, eff)

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
})
