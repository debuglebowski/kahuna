import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AutosaveStatus, createAutosave } from "./autosave"

const conflict = () => Object.assign(new Error("VersionConflict"), { code: "VERSION_CONFLICT" })
const isConflict = (e: unknown) => (e as { code?: string })?.code === "VERSION_CONFLICT"

/** Spin the microtask queue until `cond` holds (saves start on microtasks). */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve()
  expect(cond()).toBe(true)
}

const harness = (over: { save?: ReturnType<typeof vi.fn>; fetchVersion?: ReturnType<typeof vi.fn> } = {}) => {
  const statuses: Array<[AutosaveStatus, string | null]> = []
  // Default server: ack with version+1.
  const save = over.save ?? vi.fn((_v: string, version: number) => Promise.resolve(version + 1))
  const fetchVersion = over.fetchVersion ?? vi.fn(() => Promise.resolve(0))
  const autosave = createAutosave<string>({
    save,
    fetchVersion,
    isConflict,
    onStatus: (s, e) => statuses.push([s, e]),
  })
  return { autosave, save, fetchVersion, statuses }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createAutosave", () => {
  it("debounces: rapid changes collapse into one save of the latest value", async () => {
    const { autosave, save, statuses } = harness()
    autosave.bumpVersion(3)
    autosave.change("a")
    autosave.change("ab")
    autosave.change("abc")
    await vi.advanceTimersByTimeAsync(1499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith("abc", 3)
    expect(statuses.at(-1)).toEqual(["idle", null])
  })

  it("flush saves immediately and cancels the pending timer", async () => {
    const { autosave, save } = harness()
    autosave.change("x")
    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000) // timer must not fire a second save
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("flush with nothing pending is a no-op", async () => {
    const { autosave, save, statuses } = harness()
    await autosave.flush()
    expect(save).not.toHaveBeenCalled()
    expect(statuses).toEqual([])
  })

  it("chains the version from each save response", async () => {
    const { autosave, save } = harness()
    autosave.bumpVersion(3)
    autosave.change("a")
    await autosave.flush() // server acks 4
    autosave.change("b")
    await autosave.flush()
    expect(save).toHaveBeenNthCalledWith(2, "b", 4)
  })

  it("bumpVersion is monotonic — stale (lower) versions are ignored", async () => {
    const { autosave, save } = harness()
    autosave.bumpVersion(10)
    autosave.bumpVersion(2) // e.g. a stale ctx render
    autosave.change("x")
    await autosave.flush()
    expect(save).toHaveBeenCalledWith("x", 10)
  })

  it("conflict: refreshes the version and retries exactly once", async () => {
    const save = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(12)
    const fetchVersion = vi.fn().mockResolvedValue(11)
    const { autosave, statuses } = harness({ save, fetchVersion })
    autosave.bumpVersion(5)
    autosave.change("x")
    await autosave.flush()
    expect(fetchVersion).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenNthCalledWith(1, "x", 5)
    expect(save).toHaveBeenNthCalledWith(2, "x", 11)
    expect(statuses.at(-1)).toEqual(["idle", null])
    // The retry's response chained forward:
    autosave.change("y")
    await autosave.flush()
    expect(save).toHaveBeenNthCalledWith(3, "y", 12)
  })

  it("a second conflict surfaces as an error, not an endless retry", async () => {
    const save = vi.fn().mockRejectedValue(conflict())
    const fetchVersion = vi.fn().mockResolvedValue(11)
    const { autosave, statuses } = harness({ save, fetchVersion })
    autosave.change("x")
    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)?.[0]).toBe("error")
  })

  it("non-conflict errors report the message; the next change recovers", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(7)
    const { autosave, statuses } = harness({ save })
    autosave.change("x")
    await autosave.flush()
    expect(statuses.at(-1)).toEqual(["error", "boom"])
    autosave.change("y")
    await autosave.flush()
    expect(statuses.at(-1)).toEqual(["idle", null])
  })

  it("errors without a message fall back to a generic one", async () => {
    const save = vi.fn().mockRejectedValueOnce({})
    const { autosave, statuses } = harness({ save })
    autosave.change("x")
    await autosave.flush()
    expect(statuses.at(-1)).toEqual(["error", "Save failed"])
  })

  it("a change during an in-flight save stays 'saving', then saves serially", async () => {
    const releases: Array<(n: number) => void> = []
    const save = vi.fn((_v: string, _ver: number) => new Promise<number>((r) => releases.push(r)))
    const { autosave, statuses } = harness({ save })
    autosave.bumpVersion(5)
    autosave.change("a")
    const first = autosave.flush()
    await until(() => releases.length === 1) // save #1 in flight
    autosave.change("b") // typed while saving
    expect(statuses.at(-1)?.[0]).toBe("saving") // not downgraded to dirty
    releases[0]?.(6)
    await first
    expect(statuses.at(-1)?.[0]).toBe("dirty") // newer keystrokes still unsaved
    const second = autosave.flush()
    await until(() => releases.length === 2)
    expect(save).toHaveBeenNthCalledWith(2, "b", 6) // serialized, chained version
    releases[1]?.(7)
    await second
    expect(statuses.at(-1)).toEqual(["idle", null])
  })
})
