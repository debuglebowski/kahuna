import { describe, expect, it } from "vitest"
import type { InstanceViewPrefsBody } from "../../rpc/contract"
import {
  CUSTOM_VIEW_KEY,
  DEFAULT_VIEW_KEY,
  INSTANCE_VIEWS,
  resolveView,
  resolveViewKey,
  sanitizeTiles,
} from "./instanceViews"

const body = (over: Partial<InstanceViewPrefsBody>): InstanceViewPrefsBody => ({
  defaultView: null,
  byConcept: {},
  customByConcept: {},
  ...over,
})

describe("resolveViewKey", () => {
  it("falls through concept override → default → built-in", () => {
    expect(resolveViewKey(body({}), "c1")).toBe(DEFAULT_VIEW_KEY)
    expect(resolveViewKey(body({ defaultView: "document" }), "c1")).toBe("document")
    expect(
      resolveViewKey(body({ defaultView: "document", byConcept: { c1: "three-pane" } }), "c1"),
    ).toBe("three-pane")
  })

  it("ignores unknown keys (a removed preset surviving in saved prefs)", () => {
    expect(
      resolveViewKey(body({ byConcept: { c1: "gone" }, defaultView: "also-gone" }), "c1"),
    ).toBe(DEFAULT_VIEW_KEY)
  })

  it("resolves custom only when a non-empty layout is stored", () => {
    const tiles = [{ id: "a", contents: ["details"], x: 0, y: 0, w: 6, h: 4 }]
    expect(
      resolveViewKey(
        body({ byConcept: { c1: CUSTOM_VIEW_KEY }, customByConcept: { c1: { tiles } } }),
        "c1",
      ),
    ).toBe(CUSTOM_VIEW_KEY)
    // Dangling "custom" override with no layout falls back.
    expect(resolveViewKey(body({ byConcept: { c1: CUSTOM_VIEW_KEY } }), "c1")).toBe(
      DEFAULT_VIEW_KEY,
    )
    // A layout whose tiles all sanitize away counts as empty.
    const junk = [{ id: "a", contents: ["from-the-future"], x: 0, y: 0, w: 6, h: 4 }]
    expect(
      resolveViewKey(
        body({ byConcept: { c1: CUSTOM_VIEW_KEY }, customByConcept: { c1: { tiles: junk } } }),
        "c1",
      ),
    ).toBe(DEFAULT_VIEW_KEY)
  })
})

describe("resolveView", () => {
  it("returns the custom layout's tiles regardless of concept caps", () => {
    const tiles = [{ id: "a", contents: ["details", "notes"], x: 0, y: 0, w: 8, h: 4 }]
    const view = resolveView(
      body({ byConcept: { c1: CUSTOM_VIEW_KEY }, customByConcept: { c1: { tiles } } }),
      "c1",
    )
    expect(view.key).toBe(CUSTOM_VIEW_KEY)
    expect(view.tiles({ versioned: false, hasDocuments: false })).toEqual(tiles)
  })

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
