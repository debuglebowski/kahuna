import { randomUUID } from "node:crypto"
import type { EngineServices, OrgContext } from "@kingsmaker/engine"
import type { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import {
  createInstance,
  getChanged,
  getConceptGraph,
  getInstanceDetail,
  linkRelation,
  listConcepts,
  listFields,
} from "./use-cases"

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow({ orgId, actor: "system" }, eff)

type FieldRow = { id: string; name: string; kind: string }

describe("use-cases (UI backbone)", () => {
  it("builds a graph from generic primitives, keyed by field id, and surfaces it", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // The app identifies concepts + fields by id; resolve seeded names → ids.
    const concepts = (await run(org, listConcepts)) as ReadonlyArray<{ id: string; name: string }>
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
