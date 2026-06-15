import { describe, expect, it } from "vitest"
import type { Concept, InstanceViewLayout } from "../../rpc/contract"
import { conceptInstanceView, DEFAULT_VIEW, INSTANCE_VIEWS, sanitizeTiles } from "./instanceViews"

const concept = (instanceView: InstanceViewLayout | null): Concept =>
  ({
    id: "c1",
    slug: "c1",
    name: "Account",
    pluralName: null,
    description: null,
    icon: null,
    color: null,
    managedBy: null,
    staticLabelIds: [],
    defaultLabelIds: [],
    versioningEnabled: false,
    instanceView,
    titleFieldId: null,
    archivedAt: null,
  }) as Concept

describe("conceptInstanceView", () => {
  it("falls back to the built-in default when no layout is stored", () => {
    expect(conceptInstanceView(concept(null)).key).toBe(DEFAULT_VIEW.key)
  })

  it("uses the concept's stored layout when tiles survive sanitizing", () => {
    const tiles = [{ id: "a", contents: ["details", "notes"], x: 0, y: 0, w: 8, h: 4 }]
    const view = conceptInstanceView(concept({ tiles }))
    expect(view.key).toBe("concept")
    // A stored layout is fixed — caps don't re-flow it (the canvas prunes contents).
    expect(view.tiles({ versioned: false, hasDocuments: false })).toEqual(tiles)
  })

  it("falls back when the stored layout sanitizes away (all-unknown contents)", () => {
    const junk = [{ id: "a", contents: ["from-the-future"], x: 0, y: 0, w: 6, h: 4 }]
    expect(conceptInstanceView(concept({ tiles: junk })).key).toBe(DEFAULT_VIEW.key)
  })
})

describe("presets (templates)", () => {
  it("every preset yields tiles with and without versioning", () => {
    for (const v of INSTANCE_VIEWS) {
      expect(v.tiles({ versioned: true, hasDocuments: false }).length).toBeGreaterThan(0)
      expect(v.tiles({ versioned: false, hasDocuments: false }).length).toBeGreaterThan(0)
      // No tile may be versions-ONLY in a non-versioned flow: pruning the
      // content would empty the tile and leave a grid hole. (versions as one
      // tab among others is fine — the tab prunes, the tile stays.)
      for (const t of v.tiles({ versioned: false, hasDocuments: false })) {
        expect(t.contents.some((k) => k !== "versions")).toBe(true)
      }
    }
  })

  it("hasDocuments carves a document tile (or tab) into every preset", () => {
    for (const v of INSTANCE_VIEWS) {
      const tiles = v.tiles({ versioned: false, hasDocuments: true })
      expect(tiles.some((t) => t.contents.includes("document"))).toBe(true)
      // No overlap: tiles occupy distinct grid rows per column band (spot-check
      // that no two tiles share an identical x/y origin).
      const origins = tiles.map((t) => `${t.x},${t.y}`)
      expect(new Set(origins).size).toBe(origins.length)
    }
  })
})

describe("sanitizeTiles", () => {
  it("drops unknown contents, clamps coords to the grid, removes emptied tiles", () => {
    expect(
      sanitizeTiles([
        { id: "a", contents: ["details", "hologram"], x: -2, y: -1, w: 99, h: 0 },
        { id: "b", contents: ["hologram"], x: 0, y: 0, w: 4, h: 3 },
        { id: "c", contents: ["notes"], x: 10, y: 2, w: 6, h: 2.6 },
      ]),
    ).toEqual([
      { id: "a", contents: ["details"], x: 0, y: 0, w: 12, h: 1 },
      { id: "c", contents: ["notes"], x: 10, y: 2, w: 2, h: 3 },
    ])
  })
})
