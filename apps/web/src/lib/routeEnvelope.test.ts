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

const GLOBALS = [KEY.concepts, KEY.owed, KEY.changed, KEY.demand]

describe("routeEnvelope", () => {
  it("always nudges the changed feed (when mounted)", () => {
    expect(routeEnvelope(env({ concept: "Deal" }), [KEY.changed])).toEqual([KEY.changed])
  })

  it("filters out keys that aren't mounted", () => {
    // Owed not mounted → a Deal change refetches nothing but the (unmounted) changed feed.
    expect(routeEnvelope(env({ concept: "Deal" }), [])).toEqual([])
  })

  it("Deal change refetches owed (dashboard aggregate)", () => {
    const keys = new Set(routeEnvelope(env({ concept: "Deal" }), GLOBALS))
    expect(keys).toEqual(new Set([KEY.changed, KEY.owed]))
  })

  it("Signal change refetches demand (dashboard aggregate)", () => {
    const keys = new Set(routeEnvelope(env({ concept: "Signal" }), GLOBALS))
    expect(keys).toEqual(new Set([KEY.changed, KEY.demand]))
  })

  it("relation change refetches owed + demand", () => {
    const keys = new Set(routeEnvelope(env({ kind: "relation", concept: null }), GLOBALS))
    expect(keys).toEqual(new Set([KEY.changed, KEY.owed, KEY.demand]))
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

  it("Account is now just a generic concept (no special aggregates)", () => {
    const mounted = [...GLOBALS, KEY.instances("Account")]
    const keys = new Set(routeEnvelope(env({ concept: "Account", subjectId: "acc1" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.instances("Account")]))
  })
})
