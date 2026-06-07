import { randomUUID } from "node:crypto"
import type { EngineServices, Instance, OrgContext } from "@kingsmaker/engine"
import type { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import {
  createInstance,
  getChanged,
  getDemand,
  getOwed,
  linkRelation,
  listConcepts,
} from "./use-cases"

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow({ orgId, actor: "system" }, eff)

describe("use-cases (UI backbone)", () => {
  it("builds a graph from generic primitives and surfaces it in the three reads", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    // The app identifies concepts by id; resolve the seeded names → ids once.
    const concepts = (await run(org, listConcepts)) as ReadonlyArray<{ id: string; name: string }>
    const idOf = (name: string) => concepts.find((c) => c.name === name)!.id

    // Everything is created via the generic createInstance + linkRelation — no
    // account-specific helpers. Relation types match the seeded schema.
    const account = await run(
      org,
      createInstance(idOf("Account"), {
        name: "Acme",
        lifecycle_phase: "deal",
        contract_value: 75000,
      }),
    )
    const deal = await run(org, createInstance(idOf("Deal"), { status: "lead", is_renewal: false }))
    await run(org, linkRelation("for", deal.id, account.id))

    // A stale interaction (40 days ago) on the account -> the deal reads "cold".
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString()
    const interaction = await run(
      org,
      createInstance(idOf("Interaction"), {
        occurred_on: fortyDaysAgo,
        kind: "call",
        note: "kickoff",
      }),
    )
    await run(org, linkRelation("on", interaction.id, account.id))

    const signal = await run(
      org,
      createInstance(idOf("Signal"), {
        kind: "request",
        description: "SSO please",
        status: "captured",
      }),
    )
    await run(org, linkRelation("from", signal.id, account.id))

    await run(org, createInstance(idOf("Task"), { title: "Send proposal", done: false }))

    // "What's owed": the cold deal + the open task surface.
    const owed = (await run(org, getOwed)) as {
      openTasks: ReadonlyArray<Instance>
      decayingDeals: ReadonlyArray<Instance>
    }
    expect(owed.openTasks.length).toBe(1)
    expect(owed.decayingDeals.some((d) => d.id === deal.id)).toBe(true)
    expect((owed.decayingDeals[0]?.state.decay as { band?: string }).band).toBe("cold")

    // "Demand": the signal weighted by account value.
    const demand = (await run(org, getDemand)) as ReadonlyArray<{
      weight: number
      accountName: string | null
    }>
    expect(demand.length).toBe(1)
    expect(demand[0]?.weight).toBe(75000)
    expect(demand[0]?.accountName).toBe("Acme")

    // "What changed": events recorded across the workflow.
    const changed = (await run(org, getChanged)) as ReadonlyArray<unknown>
    expect(changed.length).toBeGreaterThan(5)
  })
})
