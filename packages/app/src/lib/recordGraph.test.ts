import { describe, expect, it } from "vitest"
import {
  buildRecordGraph,
  DEFAULT_GRAPH_CONFIG,
  type GraphSeed,
  type RelatedEdge,
} from "./recordGraph"

/** Minimal world: relations declared once per record version as outbound; the
 *  helper materialises the inbound mirror on the target automatically. */
function world(
  recordVersions: Record<string, { recordId: string; label: string }>,
  rels: ReadonlyArray<{ id: string; fieldId: string; name: string; from: string; to: string }>,
) {
  const edgesOf = new Map<string, RelatedEdge[]>()
  const push = (recordVersionId: string, e: RelatedEdge) => {
    const list = edgesOf.get(recordVersionId) ?? []
    list.push(e)
    edgesOf.set(recordVersionId, list)
  }
  const ref = (id: string) => ({ id, recordId: recordVersions[id]!.recordId })
  for (const r of rels) {
    const base = {
      relationId: r.id,
      fieldId: r.fieldId,
      relationName: r.name,
      conceptId: "c1",
      conceptName: "Contact",
      pinned: false,
    }
    push(r.from, {
      ...base,
      label: recordVersions[r.to]!.label,
      direction: "out",
      recordVersion: ref(r.to),
    })
    push(r.to, {
      ...base,
      label: recordVersions[r.from]!.label,
      direction: "in",
      recordVersion: ref(r.from),
    })
  }
  return async (recordVersionId: string) => edgesOf.get(recordVersionId) ?? []
}

const seedOf = (id: string, label: string): GraphSeed => ({
  recordId: `item-${id}`,
  recordVersionId: id,
  label,
  conceptId: "c1",
  conceptName: "Contact",
})

const people = {
  anna: { recordId: "item-anna", label: "Anna" },
  bob: { recordId: "item-bob", label: "Bob" },
  cara: { recordId: "item-cara", label: "Cara" },
  dave: { recordId: "item-dave", label: "Dave" },
}

describe("buildRecordGraph", () => {
  it("walks both directions and keeps relation arrows oriented from → to", async () => {
    // Anna reports_to Bob; Cara reports_to Anna.
    const fetch = world(people, [
      { id: "r1", fieldId: "f1", name: "reports_to", from: "anna", to: "bob" },
      { id: "r2", fieldId: "f1", name: "reports_to", from: "cara", to: "anna" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, DEFAULT_GRAPH_CONFIG)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["item-anna", "item-bob", "item-cara"])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: "item-anna", target: "item-bob" }),
    )
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: "item-cara", target: "item-anna" }),
    )
    expect(g.truncated).toBe(false)
  })

  it("terminates on cycles and dedupes the edge seen from both endpoints", async () => {
    const fetch = world(people, [
      { id: "r1", fieldId: "f1", name: "reports_to", from: "anna", to: "bob" },
      { id: "r2", fieldId: "f1", name: "reports_to", from: "bob", to: "anna" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, {
      ...DEFAULT_GRAPH_CONFIG,
      depth: 6,
    })
    expect(g.nodes).toHaveLength(2)
    expect(g.edges).toHaveLength(2)
  })

  it("keeps self-loops as same-endpoint edges", async () => {
    const fetch = world(people, [
      { id: "r1", fieldId: "f1", name: "mirrors", from: "anna", to: "anna" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, DEFAULT_GRAPH_CONFIG)
    expect(g.nodes).toHaveLength(1)
    expect(g.edges).toEqual([expect.objectContaining({ source: "item-anna", target: "item-anna" })])
  })

  it("stops at the configured depth", async () => {
    const fetch = world(people, [
      { id: "r1", fieldId: "f1", name: "reports_to", from: "anna", to: "bob" },
      { id: "r2", fieldId: "f1", name: "reports_to", from: "bob", to: "cara" },
      { id: "r3", fieldId: "f1", name: "reports_to", from: "cara", to: "dave" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, {
      ...DEFAULT_GRAPH_CONFIG,
      depth: 2,
    })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["item-anna", "item-bob", "item-cara"])
    const cara = g.nodes.find((n) => n.id === "item-cara")
    expect(cara?.depth).toBe(2)
  })

  it("traverses only the allowed relation fields", async () => {
    const fetch = world(people, [
      { id: "r1", fieldId: "f-reports", name: "reports_to", from: "anna", to: "bob" },
      { id: "r2", fieldId: "f-knows", name: "knows", from: "anna", to: "cara" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, {
      ...DEFAULT_GRAPH_CONFIG,
      fieldIds: ["f-reports"],
    })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["item-anna", "item-bob"])
    expect(g.edges).toHaveLength(1)
  })

  it("flags truncation when the node cap stops the walk", async () => {
    const fetch = world(people, [
      { id: "r1", fieldId: "f1", name: "reports_to", from: "anna", to: "bob" },
      { id: "r2", fieldId: "f1", name: "reports_to", from: "anna", to: "cara" },
      { id: "r3", fieldId: "f1", name: "reports_to", from: "anna", to: "dave" },
    ])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, DEFAULT_GRAPH_CONFIG, 2)
    expect(g.nodes).toHaveLength(2)
    expect(g.truncated).toBe(true)
  })

  it("renders dangling refs as non-expandable ghost leaves", async () => {
    const ghostEdge: RelatedEdge = {
      relationId: "r-ghost",
      fieldId: "f1",
      relationName: "reports_to",
      label: "Archived Tom",
      direction: "out",
      conceptId: "c1",
      conceptName: "Contact",
      pinned: false,
      recordVersion: null,
    }
    const fetch = async (id: string) => (id === "anna" ? [ghostEdge] : [])
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, {
      ...DEFAULT_GRAPH_CONFIG,
      depth: 4,
    })
    const ghost = g.nodes.find((n) => n.ghost)
    expect(ghost).toMatchObject({
      id: "ghost:r-ghost",
      recordVersionId: null,
      label: "Archived Tom",
    })
    expect(g.edges).toEqual([
      expect.objectContaining({ source: "item-anna", target: "ghost:r-ghost" }),
    ])
  })

  it("collapses latest + pinned refs to the same item into one node", async () => {
    // Two relations from Anna to Bob's item: one Latest, one pinned to an
    // older record version of the same lineage.
    const mk = (relationId: string, recordVersionId: string, pinned: boolean): RelatedEdge => ({
      relationId,
      fieldId: "f1",
      relationName: "reports_to",
      label: "Bob",
      direction: "out",
      conceptId: "c1",
      conceptName: "Contact",
      pinned,
      recordVersion: { id: recordVersionId, recordId: "item-bob" },
    })
    const fetch = async (id: string) =>
      id === "anna" ? [mk("r1", "bob-v7", false), mk("r2", "bob-v3", true)] : []
    const g = await buildRecordGraph(seedOf("anna", "Anna"), fetch, DEFAULT_GRAPH_CONFIG)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["item-anna", "item-bob"])
    expect(g.edges).toHaveLength(2)
    expect(g.edges.find((e) => e.id === "r2")?.pinned).toBe(true)
  })
})
