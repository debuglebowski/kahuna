import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConceptService, type EngineServices, FieldService, type OrgContext } from "#engine"
import { runEngineOrThrow, systemScope } from "../runtime"
import { seedAllting } from "./seed"

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow(systemScope(orgId, "system"), eff)

describe("allting seed", () => {
  it("creates the 8 model concepts and is idempotent", async () => {
    const org = randomUUID()
    await run(org, seedAllting)
    await run(org, seedAllting) // re-run must not error or duplicate
    const names = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.list()).pipe(
        Effect.map((cs) => cs.map((c) => c.name).sort()),
      ),
    )
    expect(names).toEqual([
      "Agreement",
      "AgreementTemplate",
      "Company",
      "CompanyContact",
      "CompanyNote",
      "Policy",
      "Runbook",
      "Task",
    ])
  })

  it("Agreement's relation fields resolve to concept ids + a status state machine", async () => {
    const org = randomUUID()
    await run(org, seedAllting)
    const { fields, companyId, templateId } = await run(
      org,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const company = yield* concepts.getByName("Company")
        const template = yield* concepts.getByName("AgreementTemplate")
        const agreement = yield* concepts.getByName("Agreement")
        return {
          fields: yield* fieldSvc.listFields(agreement.id),
          companyId: company.id,
          templateId: template.id,
        }
      }),
    )
    const byName = new Map(fields.map((f) => [f.name, f]))
    expect(byName.get("for")?.kind).toBe("relation")
    expect(byName.get("for")?.config.target).toBe(companyId)
    expect(byName.get("based_on")?.config.target).toBe(templateId)
    expect(byName.get("status")?.config.transitions?.draft).toContain("active")
    expect(byName.get("owner")?.kind).toBe("user")
  })

  it("CompanyContact's reports_to is a self-referencing relation", async () => {
    const org = randomUUID()
    await run(org, seedAllting)
    const { reportsTo, contactId } = await run(
      org,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const contact = yield* concepts.getByName("CompanyContact")
        const fs = yield* fieldSvc.listFields(contact.id)
        return { reportsTo: fs.find((f) => f.name === "reports_to"), contactId: contact.id }
      }),
    )
    expect(reportsTo?.kind).toBe("relation")
    expect(reportsTo?.config.target).toBe(contactId)
    expect(reportsTo?.config.cardinality).toBe("one")
  })

  it("CompanyNote carries a user (author) field", async () => {
    const org = randomUUID()
    await run(org, seedAllting)
    const author = await run(
      org,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const note = yield* concepts.getByName("CompanyNote")
        const fs = yield* fieldSvc.listFields(note.id)
        return fs.find((f) => f.name === "author")
      }),
    )
    expect(author?.kind).toBe("user")
  })
})
