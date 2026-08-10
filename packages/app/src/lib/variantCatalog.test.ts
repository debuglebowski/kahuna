import { DashboardBody } from "@alltinghq/contract"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  defaultVariantId,
  findVariant,
  resolveVariantId,
  VARIANT_CATALOG,
  variantPatch,
  variantsFor,
} from "./variantCatalog"
import { WIDGET_CATALOG } from "./widgetCatalog"

describe("variant catalog", () => {
  it("covers every widget type with ≥1 variant, unique ids, and a default", () => {
    for (const meta of WIDGET_CATALOG) {
      const variants = variantsFor(meta.type)
      expect(variants.length, `${meta.type} has no variants`).toBeGreaterThanOrEqual(1)
      const ids = variants.map((v) => v.id)
      expect(new Set(ids).size, `${meta.type} has duplicate variant ids`).toBe(ids.length)
      // The default is the first entry — the renderer's `?? "<default>"` fallback
      // must match it, so an unset widget and the explicit default render alike.
      expect(defaultVariantId(meta.type)).toBe(ids[0])
    }
  })

  it("has a catalog entry for exactly the known widget types", () => {
    const known = new Set(WIDGET_CATALOG.map((m) => m.type))
    expect(new Set(Object.keys(VARIANT_CATALOG))).toEqual(known)
  })

  it("resolveVariantId prefers an explicit variant, else the type default", () => {
    expect(resolveVariantId({ type: "metric" })).toBe("tile")
    expect(resolveVariantId({ type: "metric", variant: "bar" })).toBe("bar")
    // Free-form: an id not in the catalog still resolves to itself (renderer falls back).
    expect(resolveVariantId({ type: "metric", variant: "spark" })).toBe("spark")
  })

  it("variantPatch always sets the id and merges the variant's preset", () => {
    for (const [type, variants] of Object.entries(VARIANT_CATALOG)) {
      for (const v of variants) {
        const patch = variantPatch(type as (typeof WIDGET_CATALOG)[number]["type"], v.id)
        expect(patch.variant).toBe(v.id)
        for (const [k, val] of Object.entries(v.preset ?? {})) {
          expect(patch[k]).toEqual(val)
        }
      }
    }
  })

  it("variantPatch on an unknown id just sets the variant (no preset)", () => {
    expect(variantPatch("metric", "nope")).toEqual({ variant: "nope" })
    expect(findVariant("metric", "nope")).toBeUndefined()
  })
})

describe("widget base `variant` schema", () => {
  const widget = (extra: Record<string, unknown>) => ({
    direction: "row" as const,
    children: [
      {
        id: "w1",
        title: null,
        w: { unit: "fr" as const, value: 1 },
        h: { unit: "fr" as const, value: 1 },
        ...extra,
      },
    ],
  })

  it("round-trips an arbitrary variant string (free-form by design)", () => {
    const body = widget({
      type: "metric",
      conceptId: "c1",
      conditions: [],
      agg: "count",
      variant: "spark",
    })
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    expect(Schema.encodeSync(DashboardBody)(decoded)).toEqual(body)
  })

  it("accepts a variant on a type that had no built-in variant (kanban)", () => {
    const body = widget({
      type: "kanban",
      conceptId: "c1",
      conditions: [],
      groupBy: "f1",
      variant: "compact",
    })
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    const w = decoded.children?.[0] as { variant?: string }
    expect(w.variant).toBe("compact")
  })
})
