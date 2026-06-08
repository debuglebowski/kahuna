import { describe, expect, it } from "vitest"
import { KEY, type LiveEnvelope, routeEnvelope } from "./routeEnvelope"

const env = (over: Partial<LiveEnvelope>): LiveEnvelope => ({
  org: "o",
  id: 1,
  at: 0,
  kind: "instance",
  subjectId: "x",
  type: "InstanceUpdated",
  conceptId: null,
  concept: null,
  ...over,
})

const GLOBALS = [KEY.concepts, KEY.changed]

describe("routeEnvelope", () => {
  it("always nudges the changed feed (when mounted)", () => {
    expect(routeEnvelope(env({ concept: "Deal" }), [KEY.changed])).toEqual([KEY.changed])
  })

  it("filters out keys that aren't mounted", () => {
    // Nothing mounted → a Deal change refetches nothing.
    expect(routeEnvelope(env({ concept: "Deal" }), [])).toEqual([])
  })

  it("an instance change only nudges the changed feed when no list/detail is mounted", () => {
    const keys = new Set(routeEnvelope(env({ concept: "Deal", conceptId: "deal-id" }), GLOBALS))
    expect(keys).toEqual(new Set([KEY.changed]))
  })

  it("relation change with nothing relevant mounted only nudges the changed feed", () => {
    const keys = new Set(routeEnvelope(env({ kind: "relation", concept: null }), GLOBALS))
    expect(keys).toEqual(new Set([KEY.changed]))
  })

  it("concept/field change refetches concepts", () => {
    expect(new Set(routeEnvelope(env({ kind: "concept" }), GLOBALS))).toEqual(
      new Set([KEY.changed, KEY.concepts]),
    )
  })

  it("generic concept routes to its mounted ConceptView (by concept id)", () => {
    const mounted = [KEY.changed, KEY.instances("widget-id")]
    const keys = new Set(routeEnvelope(env({ concept: "Widget", conceptId: "widget-id" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.instances("widget-id")]))
  })

  it("instance change with its ConceptView mounted refetches that collection", () => {
    const mounted = [...GLOBALS, KEY.instances("account-id")]
    const keys = new Set(
      routeEnvelope(
        env({ concept: "Account", conceptId: "account-id", subjectId: "acc1" }),
        mounted,
      ),
    )
    expect(keys).toEqual(new Set([KEY.changed, KEY.instances("account-id")]))
  })

  it("instance change nudges mounted detail pages (viewed or connected)", () => {
    // A detail page may render the changed instance directly or as a connected
    // one — either way it refetches. Unmounted detail pages stay untouched.
    const mounted = [KEY.changed, KEY.detail("acc1"), KEY.detail("other")]
    const keys = new Set(
      routeEnvelope(env({ conceptId: "account-id", subjectId: "acc1" }), mounted),
    )
    expect(keys).toEqual(new Set([KEY.changed, KEY.detail("acc1"), KEY.detail("other")]))
  })

  it("relation change nudges mounted detail pages (a link was added/removed)", () => {
    const mounted = [KEY.changed, KEY.detail("acc1")]
    const keys = new Set(routeEnvelope(env({ kind: "relation", concept: null }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.detail("acc1")]))
  })

  it("does not nudge a detail key that isn't mounted", () => {
    expect(routeEnvelope(env({ conceptId: "c", subjectId: "x" }), [KEY.changed])).toEqual([
      KEY.changed,
    ])
  })
})
