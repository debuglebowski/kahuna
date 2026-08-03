import { describe, expect, it } from "vitest"
import type { EventEnvelope } from "#engine"
import { dispatch, subscribe } from "./stream"

const env = (org: string, id: number): EventEnvelope => ({
  org,
  id,
  at: 0,
  kind: "instance",
  subjectId: `s${id}`,
  type: "InstanceCreated",
  conceptId: "deal-id",
  concept: "Deal",
  actor: "user-1",
})

describe("stream hub — org isolation", () => {
  it("delivers an org's envelopes ONLY to that org's subscribers", () => {
    const a: EventEnvelope[] = []
    const b: EventEnvelope[] = []
    const unsubA = subscribe("orgA", (e) => a.push(e))
    const unsubB = subscribe("orgB", (e) => b.push(e))

    dispatch(env("orgA", 1))
    dispatch(env("orgB", 2))
    dispatch(env("orgA", 3))

    expect(a.map((e) => e.id)).toEqual([1, 3])
    expect(b.map((e) => e.id)).toEqual([2])
    // The load-bearing property: no cross-org leakage in either direction.
    expect(a.every((e) => e.org === "orgA")).toBe(true)
    expect(b.every((e) => e.org === "orgB")).toBe(true)

    unsubA()
    dispatch(env("orgA", 4))
    expect(a.map((e) => e.id)).toEqual([1, 3]) // unsubscribed → nothing more

    unsubB()
  })

  it("supports multiple subscribers in the same org and tolerates empty orgs", () => {
    const a1: number[] = []
    const a2: number[] = []
    const unsub1 = subscribe("orgC", (e) => a1.push(e.id))
    const unsub2 = subscribe("orgC", (e) => a2.push(e.id))

    dispatch(env("orgC", 7))
    expect(a1).toEqual([7])
    expect(a2).toEqual([7])

    expect(() => dispatch(env("nobody", 99))).not.toThrow()

    unsub1()
    unsub2()
  })
})

describe("stream hub — within-org visibility", () => {
  it("drops envelopes for concepts the subscriber may not read", () => {
    // The envelope carries the concept NAME and the record id, so an unfiltered
    // stream tells a member exactly what exists in a concept they cannot open.
    const seen: EventEnvelope[] = []
    const unsub = subscribe(
      "orgD",
      (e) => seen.push(e),
      (e) => e.conceptId !== "secret-id",
    )

    dispatch({ ...env("orgD", 1), conceptId: "deal-id", concept: "Deal" })
    dispatch({ ...env("orgD", 2), conceptId: "secret-id", concept: "Salaries" })
    dispatch({ ...env("orgD", 3), conceptId: null, concept: null })

    // The visible concept and the concept-less envelope arrive; the restricted one
    // never does — and neither does its NAME.
    expect(seen.map((e) => e.id)).toEqual([1, 3])
    expect(seen.some((e) => e.concept === "Salaries")).toBe(false)
    unsub()
  })

  it("fails CLOSED when the predicate throws", () => {
    // A broken snapshot must drop frames, never pass them: the failure mode of a
    // leak is unrecoverable, the failure mode of a missed refetch is a stale tab.
    const seen: number[] = []
    const unsub = subscribe(
      "orgE",
      (e) => seen.push(e.id),
      () => {
        throw new Error("snapshot unavailable")
      },
    )
    dispatch(env("orgE", 1))
    expect(seen).toEqual([])
    unsub()
  })

  it("a subscriber with no predicate is unfiltered (server-side taps, tests)", () => {
    const seen: number[] = []
    const unsub = subscribe("orgF", (e) => seen.push(e.id))
    dispatch(env("orgF", 1))
    expect(seen).toEqual([1])
    unsub()
  })
})
