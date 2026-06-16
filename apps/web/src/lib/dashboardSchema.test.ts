import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DashboardBody } from "../../rpc/contract"

// Proves the RECURSIVE contract schema (the actual codec the RPC layer runs on
// save/read) round-trips a nested group tree — the highest-risk piece, since a
// recursive Effect schema can silently mis-encode nesting.
describe("DashboardBody schema codec (recursive tree)", () => {
  const tree = {
    direction: "row" as const,
    children: [
      {
        id: "w1",
        type: "note" as const,
        title: null,
        w: { unit: "fr" as const, value: 1 },
        h: { unit: "tiles" as const, value: 10 },
      },
      {
        id: "g1",
        type: "group" as const,
        direction: "col" as const,
        w: { unit: "fr" as const, value: 2 },
        h: { unit: "fr" as const, value: 1 },
        children: [
          {
            id: "w2",
            type: "metric" as const,
            title: null,
            conceptId: "c1",
            conditions: [],
            agg: "count" as const,
            w: { unit: "fr" as const, value: 1 },
            h: { unit: "fr" as const, value: 1 },
          },
          {
            id: "g2",
            type: "group" as const,
            direction: "row" as const,
            w: { unit: "fr" as const, value: 1 },
            h: { unit: "fr" as const, value: 1 },
            children: [
              {
                id: "w3",
                type: "note" as const,
                title: null,
                w: { unit: "pct" as const, value: 50, min: 4, max: 20 },
                h: { unit: "fr" as const, value: 1 },
              },
            ],
          },
        ],
      },
    ],
  }

  it("decodes then re-encodes a 3-level tree losslessly", () => {
    const decoded = Schema.decodeUnknownSync(DashboardBody)(tree)
    const encoded = Schema.encodeSync(DashboardBody)(decoded)
    expect(encoded).toEqual(tree)
  })

  it("still decodes a legacy flat body (back-compat read)", () => {
    const legacy = {
      widgets: [{ id: "a", type: "note", title: null, layout: { x: 0, y: 0, w: 6, h: 4 } }],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(legacy)
    expect(decoded.widgets?.[0]?.id).toBe("a")
    expect(decoded.children).toBeUndefined()
  })

  it("rejects a malformed node (bad unit) — the codec actually validates", () => {
    const bad = {
      direction: "row",
      children: [{ id: "x", type: "note", title: null, w: { unit: "bogus", value: 1 } }],
    }
    expect(() => Schema.decodeUnknownSync(DashboardBody)(bad)).toThrow()
  })
})
