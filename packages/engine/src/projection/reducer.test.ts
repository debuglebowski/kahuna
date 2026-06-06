import { Either } from "effect"
import { describe, expect, it } from "vitest"
import type { EngineEvent, EventPayload } from "../domain/types"
import { foldEvents } from "./fold"
import { applyEvent } from "./reducer"

const ev = (id: number, payload: EventPayload, occurredAt = new Date(0)): EngineEvent => ({
  id,
  orgId: "o",
  occurredAt,
  actor: "a",
  subjectKind: "instance",
  subjectId: "i",
  eventType: payload._tag,
  payload,
})

describe("reducer / fold", () => {
  it("folds create + patches; version increments; last-write wins per field", () => {
    const result = foldEvents([
      ev(1, { _tag: "InstanceCreated", conceptId: "c", fields: { status: "lead", value: 1 } }),
      ev(2, { _tag: "InstanceUpdated", patch: { value: 2 } }),
      ev(3, { _tag: "InstanceUpdated", patch: { status: "qualified" } }),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.state).toEqual({ status: "qualified", value: 2 })
      expect(result.right.version).toBe(2)
      expect(result.right.deletedAt).toBeNull()
    }
  })

  it("rejects a mutation before create", () => {
    expect(Either.isLeft(applyEvent(null, ev(1, { _tag: "InstanceUpdated", patch: {} })))).toBe(
      true,
    )
  })

  it("rejects an event after delete (no undelete)", () => {
    const result = foldEvents([
      ev(1, { _tag: "InstanceCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "InstanceDeleted" }),
      ev(3, { _tag: "InstanceUpdated", patch: { a: 1 } }),
    ])
    expect(Either.isLeft(result)).toBe(true)
  })

  it("delete sets deletedAt and bumps version", () => {
    const result = foldEvents([
      ev(1, { _tag: "InstanceCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "InstanceDeleted" }, new Date(5)),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.version).toBe(1)
      expect(result.right.deletedAt).toEqual(new Date(5))
    }
  })

  it("empty stream folds to null", () => {
    const result = foldEvents([])
    expect(Either.isRight(result) && result.right === null).toBe(true)
  })
})
