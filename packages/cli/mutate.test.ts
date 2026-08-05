import { describe, expect, it } from "vitest"
import { EXIT } from "./errors.ts"
import { requireConfirmation, withVersion } from "./mutate.ts"

const conflict = { _tag: "RpcError", code: "VERSION_CONFLICT", message: "", status: 409 }

describe("read-then-write", () => {
  it("passes the version it just read to the write", async () => {
    const seen: number[] = []
    await withVersion(
      async () => ({ version: 7 }),
      async (current) => {
        seen.push(current.version)
        return "ok"
      },
    )
    expect(seen).toEqual([7])
  })

  it("re-reads and retries ONCE on a version conflict", async () => {
    let reads = 0
    const result = await withVersion(
      async () => ({ version: ++reads }),
      async (current) => {
        // Fail on the stale version, succeed on the fresh one.
        if (current.version === 1) throw conflict
        return `wrote v${current.version}`
      },
    )
    expect(result).toBe("wrote v2")
    expect(reads).toBe(2)
  })

  it("gives up after the second conflict rather than looping forever", async () => {
    let reads = 0
    await expect(
      withVersion(
        async () => ({ version: ++reads }),
        async () => {
          throw conflict
        },
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.conflict })
    // Exactly two reads: the original and one retry.
    expect(reads).toBe(2)
  })

  it("never retries anything that is NOT a conflict", async () => {
    let writes = 0
    const denied = { code: "FORBIDDEN", status: 403 }
    await expect(
      withVersion(
        async () => ({ version: 1 }),
        async () => {
          writes++
          throw denied
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Replaying a write the server refused on purpose would be worse than failing.
    expect(writes).toBe(1)
  })

  it("can be told not to retry at all", async () => {
    let writes = 0
    await expect(
      withVersion(
        async () => ({ version: 1 }),
        async () => {
          writes++
          throw conflict
        },
        { retry: false },
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" })
    expect(writes).toBe(1)
  })
})

describe("destructive-action guard", () => {
  it("refuses without --yes", () => {
    try {
      requireConfirmation({}, "delete everything")
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.usage)
      expect((e as { hint?: string }).hint).toContain("--yes")
    }
  })

  it("allows --yes, and allows --dry-run without --yes", () => {
    expect(() => requireConfirmation({ yes: true }, "x")).not.toThrow()
    // A dry run writes nothing, so demanding confirmation for it is noise.
    expect(() => requireConfirmation({ "dry-run": true }, "x")).not.toThrow()
  })
})
