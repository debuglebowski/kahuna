import { randomUUID } from "node:crypto"
import {
  ComputedFields,
  ConceptService,
  type EngineServices,
  FieldService,
  InstanceService,
  type OrgContext,
  RelationService,
} from "@kingsmaker/engine"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runEngineOrThrow } from "../runtime"
import { seedKingsmaker } from "./seed"

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow({ orgId, actor: "system" }, eff)

describe("kingsmaker seed", () => {
  it("creates 8 concepts and is idempotent", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)
    await run(org, seedKingsmaker) // re-run must not error or duplicate
    const names = await run(
      org,
      Effect.flatMap(ConceptService, (c) => c.list()).pipe(
        Effect.map((cs) => cs.map((c) => c.name).sort()),
      ),
    )
    expect(names).toEqual([
      "Account",
      "Artifact",
      "Contact",
      "Deal",
      "Interaction",
      "Signal",
      "Task",
      "TeamMember",
    ])
  })

  it("Deal has a status state machine plus computed decay/momentum", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)
    const fields = await run(
      org,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const deal = yield* concepts.getByName("Deal")
        return yield* fieldSvc.listFields(deal.id)
      }),
    )
    const byName = new Map(fields.map((f) => [f.name, f]))
    expect(byName.get("status")?.kind).toBe("enum")
    expect(byName.get("status")?.config.transitions?.lead).toContain("qualified")
    expect(byName.get("decay")?.kind).toBe("computed")
    expect(byName.get("momentum")?.kind).toBe("computed")
  })

  it("full workflow: account + deal + enforced transition + decay", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)
    const result = await run(
      org,
      Effect.gen(function* () {
        const instances = yield* InstanceService
        const relations = yield* RelationService
        const computed = yield* ComputedFields
        const account = yield* instances.create({
          conceptName: "Account",
          fields: { lifecycle_phase: "deal", contract_value: 50000, intel: "warm intro" },
        })
        const deal = yield* instances.create({
          conceptName: "Deal",
          fields: { status: "lead", is_renewal: false },
        })
        yield* relations.create({ relationType: "for", fromId: deal.id, toId: account.id })
        const illegal = yield* instances
          .transition({ instanceId: deal.id, expectedVersion: 0, field: "status", to: "won" })
          .pipe(Effect.flip)
        const advanced = yield* instances.transition({
          instanceId: deal.id,
          expectedVersion: 0,
          field: "status",
          to: "qualified",
        })
        const decorated = yield* computed.decorate(advanced)
        return {
          illegalTag: illegal._tag,
          status: advanced.state.status,
          decay: decorated.state.decay,
          momentum: decorated.state.momentum,
        }
      }),
    )
    expect(result.illegalTag).toBe("IllegalTransition")
    expect(result.status).toBe("qualified")
    expect(result.decay).toBeDefined()
    expect(result.momentum).toBeDefined()
  })
})
