import { describe, expect, it } from "vitest"
import { decay } from "./decay"
import { momentum } from "./momentum"

const now = new Date("2026-06-01T00:00:00Z")
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

describe("decay", () => {
  it("fresh (<7d), warm (7–14), cooling (14–30), cold (>30)", () => {
    expect(decay([daysAgo(2)], now).band).toBe("fresh")
    expect(decay([daysAgo(10)], now).band).toBe("warm")
    expect(decay([daysAgo(20)], now).band).toBe("cooling")
    expect(decay([daysAgo(40)], now).band).toBe("cold")
  })

  it("uses the most recent interaction", () => {
    expect(decay([daysAgo(40), daysAgo(1)], now).band).toBe("fresh")
  })

  it("falls back to deal age when there are no interactions", () => {
    const r = decay([], now, {}, daysAgo(3))
    expect(r.days).toBe(3)
    expect(r.band).toBe("fresh")
  })

  it("no interactions and no fallback => cold / null", () => {
    expect(decay([], now)).toEqual({ days: null, band: "cold" })
  })
})

describe("momentum", () => {
  it("heating when recent window has more", () => {
    expect(momentum([daysAgo(1), daysAgo(2), daysAgo(20)], now).label).toBe("heating")
  })
  it("cooling when prior window has more", () => {
    expect(momentum([daysAgo(20), daysAgo(22), daysAgo(2)], now).label).toBe("cooling")
  })
  it("steady when equal", () => {
    expect(momentum([daysAgo(2), daysAgo(20)], now).label).toBe("steady")
  })
})
