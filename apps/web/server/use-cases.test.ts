import { randomUUID } from "node:crypto"
import type { EngineServices, Instance, OrgContext } from "@kingsmaker/engine"
import type { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import {
  createContact,
  createDeal,
  createInstance,
  createTask,
  getAccountHub,
  getChanged,
  getDemand,
  getOwed,
  logInteraction,
  logSignal,
} from "./use-cases"

const run = <A, E>(orgId: string, eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  runEngineOrThrow({ orgId, actor: "system" }, eff)

interface Hub {
  account: Instance
  contacts: ReadonlyArray<Instance>
  interactions: ReadonlyArray<Instance>
  signals: ReadonlyArray<Instance>
  deals: ReadonlyArray<Instance>
  tasks: ReadonlyArray<Instance>
}

describe("use-cases (UI backbone)", () => {
  it("runs the whole workflow and surfaces it in the three reads", async () => {
    const org = randomUUID()
    await run(org, seedKingsmaker)

    const account = await run(
      org,
      createInstance("Account", { name: "Acme", lifecycle_phase: "deal", contract_value: 75000 }),
    )
    await run(org, createContact(account.id, { name: "Dana", role: "champion" }))
    const deal = await run(org, createDeal(account.id, { status: "lead", is_renewal: false }))
    // A stale interaction (40 days ago) -> deal should read "cold".
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString()
    await run(
      org,
      logInteraction(account.id, { occurred_on: fortyDaysAgo, kind: "call", note: "kickoff" }),
    )
    await run(
      org,
      logSignal(account.id, { kind: "request", description: "SSO please", status: "captured" }),
    )
    await run(org, createTask(account.id, { title: "Send proposal", done: false }))

    // Account hub aggregates the whole graph.
    const hub = (await run(org, getAccountHub(account.id))) as Hub
    expect(hub.account.state.name).toBe("Acme")
    expect(hub.contacts.length).toBe(1)
    expect(hub.deals.length).toBe(1)
    expect(hub.interactions.length).toBe(1)
    expect(hub.signals.length).toBe(1)
    expect(hub.tasks.length).toBe(1)
    expect((hub.deals[0]?.state.decay as { band?: string }).band).toBe("cold")

    // "What's owed": the cold deal + the open task surface.
    const owed = (await run(org, getOwed)) as {
      openTasks: ReadonlyArray<Instance>
      decayingDeals: ReadonlyArray<Instance>
    }
    expect(owed.openTasks.length).toBe(1)
    expect(owed.decayingDeals.some((d) => d.id === deal.id)).toBe(true)

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
