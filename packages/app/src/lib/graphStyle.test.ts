import { describe, expect, it } from "vitest"
import { DEFAULT_GRAPH_STYLE, normalizeGraphStyle, relationLabel } from "./graphStyle"

describe("normalizeGraphStyle", () => {
  it("fills defaults for missing or junk input", () => {
    expect(normalizeGraphStyle(undefined)).toEqual(DEFAULT_GRAPH_STYLE)
    expect(normalizeGraphStyle("nope")).toEqual(DEFAULT_GRAPH_STYLE)
    expect(normalizeGraphStyle({})).toEqual(DEFAULT_GRAPH_STYLE)
  })

  it("clamps numbers, rejects non-finite, falls back on bad enums, drops unknown keys", () => {
    const s = normalizeGraphStyle({
      cornerRadius: 999,
      lineWidth: -3,
      nodeSpacing: Number.NaN,
      direction: "sideways",
      labels: "loud",
      extra: true,
    })
    expect(s.cornerRadius).toBe(24)
    expect(s.lineWidth).toBe(1)
    expect(s.nodeSpacing).toBe(DEFAULT_GRAPH_STYLE.nodeSpacing)
    expect(s.direction).toBe("down")
    expect(s.labels).toBe("both")
    expect(s).not.toHaveProperty("extra")
  })

  it("keeps valid values", () => {
    expect(
      normalizeGraphStyle({ direction: "right", labels: "none", clearance: 20 }),
    ).toMatchObject({ direction: "right", labels: "none", clearance: 20 })
  })
})

describe("relationLabel", () => {
  it("renders per mode", () => {
    expect(relationLabel("both", "Owner", "Owns")).toBe("Owner ⇄ Owns")
    expect(relationLabel("both", "Owner", null)).toBe("Owner")
    expect(relationLabel("forward", "Owner", "Owns")).toBe("Owner")
    expect(relationLabel("none", "Owner", "Owns")).toBe("")
  })
})
