import { describe, expect, it } from "vitest"
import { KEY, type LiveEnvelope, routeEnvelope } from "./routeEnvelope"

const env = (over: Partial<LiveEnvelope>): LiveEnvelope => ({
  org: "o",
  id: 1,
  at: 0,
  kind: "instance",
  subjectId: "x",
  type: "InstanceUpdated",
  concept: null,
  ...over,
})

const GLOBALS = [KEY.concepts, KEY.accounts, KEY.owed, KEY.changed, KEY.demand]

describe("routeEnvelope", () => {
  it("always nudges the changed feed (when mounted)", () => {
    expect(routeEnvelope(env({ concept: "Deal" }), [KEY.changed])).toEqual([KEY.changed])
  })

  it("filters out keys that aren't mounted", () => {
    // Owed not mounted → a Deal change refetches nothing but the (unmounted) changed feed.
    expect(routeEnvelope(env({ concept: "Deal" }), [])).toEqual([])
  })

  it("Account change refetches accounts/owed/demand + the open hub", () => {
    const mounted = [...GLOBALS, KEY.account("acc1")]
    const keys = routeEnvelope(env({ concept: "Account", subjectId: "acc1" }), mounted)
    expect(new Set(keys)).toEqual(
      new Set([KEY.changed, KEY.accounts, KEY.owed, KEY.demand, KEY.account("acc1")]),
    )
  })

  it("Deal change refetches owed + the mounted hub, not accounts/demand", () => {
    const mounted = [...GLOBALS, KEY.account("acc1")]
    const keys = new Set(routeEnvelope(env({ concept: "Deal" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.owed, KEY.account("acc1")]))
  })

  it("Signal change refetches demand + the mounted hub", () => {
    const mounted = [...GLOBALS, KEY.account("acc1")]
    const keys = new Set(routeEnvelope(env({ concept: "Signal" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.demand, KEY.account("acc1")]))
  })

  it("relation change refetches mounted hub + owed + demand", () => {
    const mounted = [...GLOBALS, KEY.account("acc1")]
    const keys = new Set(routeEnvelope(env({ kind: "relation", concept: null }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.owed, KEY.demand, KEY.account("acc1")]))
  })

  it("concept/field change refetches concepts", () => {
    expect(new Set(routeEnvelope(env({ kind: "concept" }), GLOBALS))).toEqual(
      new Set([KEY.changed, KEY.concepts]),
    )
  })

  it("generic concept routes to its mounted ConceptView", () => {
    const mounted = [KEY.changed, KEY.instances("Widget")]
    const keys = new Set(routeEnvelope(env({ concept: "Widget" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.instances("Widget")]))
  })
})
