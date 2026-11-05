import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT } from "../errors.ts"
import { run } from "../index.ts"
import { applyRequirement, requirementFromFlags, requirementLabel } from "./concept.ts"

const usageError = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    expect((e as CliError).exitCode).toBe(EXIT.usage)
    return (e as CliError).message
  }
  throw new Error("expected a usage error")
}

describe("requirementFromFlags", () => {
  it("is undefined when no requirement flag was given", () => {
    expect(requirementFromFlags({})).toBeUndefined()
    expect(requirementFromFlags({ required: false, flagged: false })).toBeUndefined()
  })

  it("reads each shorthand", () => {
    expect(requirementFromFlags({ required: true })).toBe("required")
    expect(requirementFromFlags({ flagged: true })).toBe("flagged")
    expect(requirementFromFlags({ optional: true })).toBe("optional")
  })

  it("reads --requirement", () => {
    for (const r of ["required", "flagged", "optional"]) {
      expect(requirementFromFlags({ requirement: r })).toBe(r)
    }
  })

  it("accepts a shorthand that agrees with --requirement", () => {
    expect(requirementFromFlags({ requirement: "flagged", flagged: true })).toBe("flagged")
  })

  it("rejects an unknown level", () => {
    expect(usageError(() => requirementFromFlags({ requirement: "mandatory" }))).toMatch(
      /required, flagged, optional/,
    )
  })

  it("rejects contradictions", () => {
    expect(usageError(() => requirementFromFlags({ required: true, flagged: true }))).toMatch(
      /Conflicting/,
    )
    usageError(() => requirementFromFlags({ requirement: "optional", required: true }))
  })
})

describe("applyRequirement", () => {
  it("sets required / flagged, keeping the rest of the config", () => {
    const config: Record<string, unknown> = { options: ["a"], unique: true }
    applyRequirement(config, "flagged")
    expect(config).toEqual({ options: ["a"], unique: true, requirement: "flagged" })
    applyRequirement(config, "required")
    expect(config.requirement).toBe("required")
  })

  it("optional removes the key (absent = optional, as the settings UI writes it)", () => {
    const config: Record<string, unknown> = { requirement: "required", unique: true }
    applyRequirement(config, "optional")
    expect(config).toEqual({ unique: true })
  })

  it("no flag leaves an existing requirement alone", () => {
    const config: Record<string, unknown> = { requirement: "flagged" }
    applyRequirement(config, undefined)
    expect(config).toEqual({ requirement: "flagged" })
  })
})

describe("requirementLabel", () => {
  it("shows required and flagged, blanks optional", () => {
    expect(requirementLabel({ requirement: "required" })).toBe("required")
    expect(requirementLabel({ requirement: "flagged" })).toBe("flagged")
    expect(requirementLabel({ requirement: "optional" })).toBe("")
    expect(requirementLabel({})).toBe("")
  })
})

describe("concept field add/update requirement flags", () => {
  afterEach(() => vi.restoreAllMocks())

  const runQuiet = async (argv: ReadonlyArray<string>) => {
    let err = ""
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err += String(c)
      return true
    })
    const code = await run(argv)
    vi.restoreAllMocks()
    return { code, err }
  }

  // Both fail before a session is even looked up — a contradiction must never
  // reach the server as a half-applied update.
  it("add refuses conflicting flags as a usage error", async () => {
    const { code, err } = await runQuiet([
      "concept",
      "field",
      "add",
      "Vendor",
      "--name",
      "Tax id",
      "--kind",
      "text",
      "--required",
      "--flagged",
    ])
    expect(code).toBe(EXIT.usage)
    expect(err).toMatch(/Conflicting/)
  })

  it("update refuses an unknown --requirement as a usage error", async () => {
    const { code, err } = await runQuiet([
      "concept",
      "field",
      "update",
      "Vendor",
      "Tax id",
      "--requirement",
      "soft",
    ])
    expect(code).toBe(EXIT.usage)
    expect(err).toMatch(/--requirement takes/)
  })
})
