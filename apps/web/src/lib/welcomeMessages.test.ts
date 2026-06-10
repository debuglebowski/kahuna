import { describe, expect, it } from "vitest"
import { pickWelcome, renderWelcome, WELCOME_MESSAGES } from "./welcomeMessages"

describe("WELCOME_MESSAGES", () => {
  it("has ~100 distinct, non-empty messages", () => {
    expect(WELCOME_MESSAGES.length).toBeGreaterThanOrEqual(100)
    expect(new Set(WELCOME_MESSAGES).size).toBe(WELCOME_MESSAGES.length)
    for (const m of WELCOME_MESSAGES) expect(m.trim().length).toBeGreaterThan(0)
  })
  it("many (not all) messages are personalized with {name}", () => {
    const named = WELCOME_MESSAGES.filter((m) => m.includes("{name}")).length
    expect(named).toBeGreaterThanOrEqual(40)
    expect(named).toBeLessThan(WELCOME_MESSAGES.length)
  })
})

describe("renderWelcome", () => {
  it("fills {name} with the first name", () => {
    expect(renderWelcome("Hi, {name}!", "Kalle Hansson")).toBe("Hi, Kalle!")
  })
  it("falls back when the session has no name", () => {
    expect(renderWelcome("Hi, {name}!", null)).toBe("Hi, boss!")
    expect(renderWelcome("Hi, {name}!", "  ")).toBe("Hi, boss!")
  })
})

describe("pickWelcome", () => {
  it("never leaks the {name} token", () => {
    for (let i = 0; i < 200; i++) expect(pickWelcome("Kalle")).not.toContain("{name}")
  })
})
