import type { EventEnvelope } from "@kingsmaker/engine"
import { describe, expect, it } from "vitest"
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
