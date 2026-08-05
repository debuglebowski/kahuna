import { describe, expect, it } from "vitest"
import { KEY, type LiveEnvelope, routeEnvelope } from "./routeEnvelope"

const env = (over: Partial<LiveEnvelope>): LiveEnvelope => ({
  org: "o",
  id: 1,
  at: 0,
  kind: "recordVersion",
  subjectId: "x",
  type: "RecordVersionUpdated",
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

  it("an recordVersion change only nudges the changed feed when no list/detail is mounted", () => {
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
    const mounted = [KEY.changed, KEY.recordVersions("widget-id")]
    const keys = new Set(routeEnvelope(env({ concept: "Widget", conceptId: "widget-id" }), mounted))
    expect(keys).toEqual(new Set([KEY.changed, KEY.recordVersions("widget-id")]))
  })

  it("recordVersion change with its ConceptView mounted refetches that collection", () => {
    const mounted = [...GLOBALS, KEY.recordVersions("account-id")]
    const keys = new Set(
      routeEnvelope(
        env({ concept: "Account", conceptId: "account-id", subjectId: "acc1" }),
        mounted,
      ),
    )
    expect(keys).toEqual(new Set([KEY.changed, KEY.recordVersions("account-id")]))
  })

  it("recordVersion change nudges mounted detail pages (viewed or connected)", () => {
    // A detail page may render the changed record version directly or as a connected
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

  it("recordVersion/item change nudges the concept's mounted single-record resolution", () => {
    // `/c/<slug>` resolves concept id → its one record, so a publish (which moves
    // the lineage head to a NEW record version id) has to re-run the resolution, not just
    // refetch the detail the old id pointed at.
    const mounted = [KEY.changed, KEY.singleRecord("company-id")]
    const keys = new Set(
      routeEnvelope(env({ conceptId: "company-id", subjectId: "inst1" }), mounted),
    )
    expect(keys).toEqual(new Set([KEY.changed, KEY.singleRecord("company-id")]))
  })

  it("does not nudge another concept's single-record resolution", () => {
    const mounted = [KEY.changed, KEY.singleRecord("company-id")]
    expect(routeEnvelope(env({ conceptId: "other-id", subjectId: "x" }), mounted)).toEqual([
      KEY.changed,
    ])
  })

  it("does not nudge a detail key that isn't mounted", () => {
    expect(routeEnvelope(env({ conceptId: "c", subjectId: "x" }), [KEY.changed])).toEqual([
      KEY.changed,
    ])
  })

  it("attachment events nudge mounted files panels, widgets, and activity feeds", () => {
    // The envelope's subjectId is the attachment id (not the host item), so the
    // routing fans out to every mounted files surface — incl. the widgets'
    // shared files:global key — plus the per-record activity feeds.
    const mounted = [
      KEY.changed,
      KEY.files("item1"),
      KEY.filesGlobal,
      KEY.activity("item1"),
      KEY.notes("item1"),
    ]
    const keys = new Set(routeEnvelope(env({ kind: "attachment", subjectId: "att1" }), mounted))
    expect(keys).toEqual(
      new Set([KEY.changed, KEY.files("item1"), KEY.filesGlobal, KEY.activity("item1")]),
    )
  })
})
