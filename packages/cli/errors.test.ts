import { describe, expect, it } from "vitest"
import { CliError, EXIT, exitCodeForStatus, toFailure } from "./errors.ts"

describe("exit codes", () => {
  it("maps the statuses a script branches on", () => {
    expect(exitCodeForStatus(401)).toBe(EXIT.unauthenticated)
    expect(exitCodeForStatus(403)).toBe(EXIT.forbidden)
    expect(exitCodeForStatus(404)).toBe(EXIT.notFound)
    expect(exitCodeForStatus(409)).toBe(EXIT.conflict)
  })

  it("never maps an unknown status to success", () => {
    for (const status of [undefined, 200, 418, 500]) {
      expect(exitCodeForStatus(status)).not.toBe(EXIT.ok)
    }
  })
})

describe("failure normalisation", () => {
  it("keeps a CliError's own message, hint and code", () => {
    const f = toFailure(new CliError("nope", EXIT.forbidden, "try this"))
    expect(f).toEqual({ message: "nope", hint: "try this", exitCode: EXIT.forbidden })
  })

  it("translates a known server code and carries its status", () => {
    const f = toFailure({ code: "UNAUTHENTICATED", message: "", status: 401 })
    expect(f.message).toBe("Not signed in.")
    expect(f.hint).toBe("Run `km auth login` first.")
    expect(f.exitCode).toBe(EXIT.unauthenticated)
  })

  it("prints an UNKNOWN server code verbatim rather than a generic message", () => {
    // A code we have never seen is still the most useful thing we can say —
    // "Request failed" would throw away the only clue.
    const f = toFailure({ code: "SOME_NEW_CODE", status: 400 })
    expect(f.message).toBe("SOME_NEW_CODE")
    expect(f.exitCode).toBe(EXIT.failed)
  })

  it("handles a thrown Error and a thrown string", () => {
    expect(toFailure(new Error("boom")).message).toBe("boom")
    expect(toFailure("boom").message).toBe("boom")
    expect(toFailure("boom").exitCode).toBe(EXIT.failed)
  })
})
