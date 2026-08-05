import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { unwrapExit } from "./transport.ts"

/**
 * REGRESSION. `runPromise` rejects with Effect's `FiberFailureImpl`, whose only
 * own properties are `name` and `stack` — the server's `RpcError`, carrying the
 * `code` and `status` that decide our exit code, is buried in the Cause.
 *
 * Left wrapped, every server failure exits 1 and prints Effect's message
 * instead of the server's. That is invisible in every passing case and wrong in
 * every failing one, which is why it is pinned here rather than trusted.
 */
describe("unwrapping an Exit", () => {
  it("returns the value on success", () => {
    expect(unwrapExit(Exit.succeed({ ok: true }))).toEqual({ ok: true })
  })

  it("throws the SERVER's error object, not an Effect wrapper", () => {
    const serverError = { _tag: "RpcError", code: "FORBIDDEN", message: "no", status: 403 }
    try {
      unwrapExit(Exit.fail(serverError))
      expect.unreachable("should have thrown")
    } catch (e) {
      // The properties errors.ts reads must survive the trip.
      expect((e as typeof serverError).code).toBe("FORBIDDEN")
      expect((e as typeof serverError).status).toBe(403)
    }
  })

  it("still surfaces a defect rather than swallowing it", () => {
    const exit = Exit.die(new Error("boom"))
    expect(() => unwrapExit(exit)).toThrow(/boom/)
  })

  it("matches what runPromiseExit produces for a failing effect", async () => {
    // Belt and braces: build the Exit the way the real call site does, so a
    // change in Effect's representation fails here too.
    const exit = await Effect.runPromiseExit(
      Effect.fail({ _tag: "RpcError", code: "NOT_FOUND", message: "", status: 404 }),
    )
    expect(() => unwrapExit(exit)).toThrow()
    try {
      unwrapExit(exit)
    } catch (e) {
      expect((e as { status: number }).status).toBe(404)
    }
  })
})
