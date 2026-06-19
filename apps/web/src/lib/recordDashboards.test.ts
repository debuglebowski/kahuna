import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DashboardBody as DashboardBodySchema } from "../../rpc/contract"
import type { Dashboard } from "./api"
import { migrate } from "./dashboards"
import {
  defaultRecordBody,
  resolveRecordDashboard,
  tilesToBody,
  type ViewTileLike,
} from "./recordDashboards"
import { recordHref } from "./recordHref"

const OPTS = { versioned: true, hasDocuments: true, richtextFieldId: "f-doc", conceptId: "c1" }
const widgetTypes = (body: { children?: ReadonlyArray<unknown> } | null): string[] => {
  const out: string[] = []
  const walk = (n: { type?: string; children?: ReadonlyArray<unknown> }) => {
    if (n.type === "group") {
      for (const c of n.children ?? []) walk(c as typeof n)
    } else if (n.type) {
      out.push(n.type)
    }
  }
  for (const c of body?.children ?? []) walk(c as { type?: string })
  return out
}

const dash = (id: string): Dashboard =>
  ({
    id,
    ownerId: null,
    name: id,
    icon: null,
    position: 0,
    hidden: false,
    kind: "record",
    conceptId: "c1",
    body: { widgets: [] },
  }) as Dashboard

describe("recordHref", () => {
  it("builds a bare link without a dashboard", () => {
    expect(recordHref("i1")).toBe("/instances/i1")
    expect(recordHref("i1", {})).toBe("/instances/i1")
    expect(recordHref("i1", { dashboard: null })).toBe("/instances/i1")
  })
  it("pins a record dashboard via the view query param", () => {
    expect(recordHref("i1", { dashboard: "d2" })).toBe("/instances/i1?view=d2")
  })
})

describe("resolveRecordDashboard", () => {
  // `records` are in concept order (first = opens by default).
  const records = [dash("d1"), dash("d2"), dash("d3")]

  it("honours an explicit same-concept view ref", () => {
    expect(resolveRecordDashboard(records, "d3")?.id).toBe("d3")
  })
  it("falls back to the first when the ref is stale/foreign", () => {
    expect(resolveRecordDashboard(records, "nope")?.id).toBe("d1")
  })
  it("uses the first when no ref is given", () => {
    expect(resolveRecordDashboard(records)?.id).toBe("d1")
  })
  it("returns null when the concept has no record dashboards", () => {
    expect(resolveRecordDashboard([])).toBeNull()
  })
})

const tile = (id: string, contents: string[], y: number, x = 0, w = 12): ViewTileLike => ({
  id,
  contents,
  x,
  y,
  w,
  h: 1,
})

describe("tilesToBody", () => {
  it("maps content keys to record widgets, rows by y", () => {
    const body = tilesToBody([tile("t1", ["details"], 0), tile("t2", ["notes"], 1)], OPTS)
    expect(widgetTypes(body)).toEqual(["record-details", "record-notes"])
  })

  it("turns a multi-content tile into a tabs group", () => {
    const body = tilesToBody([tile("t1", ["details", "notes", "activity"], 0)], OPTS)
    const node = body?.children?.[0] as { type?: string; display?: string; children?: unknown[] }
    expect(node.type).toBe("group")
    expect(node.display).toBe("tabs")
    expect(node.children).toHaveLength(3)
  })

  it("maps document → a document widget bound to the rich text field", () => {
    const body = tilesToBody([tile("t1", ["document"], 0)], OPTS)
    const node = body?.children?.[0] as { type?: string; fieldId?: string }
    expect(node.type).toBe("document")
    expect(node.fieldId).toBe("f-doc")
  })

  it("drops versions on a non-versioned concept and document without rich text", () => {
    const body = tilesToBody([tile("t1", ["details", "versions", "document"], 0)], {
      ...OPTS,
      versioned: false,
      hasDocuments: false,
    })
    expect(widgetTypes(body)).toEqual(["record-details"])
  })

  it("returns null when nothing applies", () => {
    expect(tilesToBody([tile("t1", ["versions"], 0)], { ...OPTS, versioned: false })).toBeNull()
  })

  it("produces a body the contract codec accepts (migrate + decode)", () => {
    const body = tilesToBody(
      [tile("t1", ["details", "notes"], 0, 0, 8), tile("t2", ["labels", "versions"], 0, 8, 4)],
      OPTS,
    )
    expect(body).not.toBeNull()
    // The runtime tree (post-migrate) re-serialises and decodes through the codec.
    const decoded = Schema.decodeUnknownSync(DashboardBodySchema)(migrate(body as object) as object)
    expect(decoded.children?.length).toBeGreaterThan(0)
  })
})

describe("defaultRecordBody", () => {
  it("includes versions only when versioned, and decodes through the codec", () => {
    expect(widgetTypes(defaultRecordBody(true))).toContain("record-versions")
    expect(widgetTypes(defaultRecordBody(false))).not.toContain("record-versions")
    const decoded = Schema.decodeUnknownSync(DashboardBodySchema)(defaultRecordBody(true) as object)
    expect(decoded.children).toHaveLength(2)
  })
})
