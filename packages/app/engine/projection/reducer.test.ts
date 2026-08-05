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
  subjectKind: "recordVersion",
  subjectId: "i",
  eventType: payload._tag,
  payload,
})

describe("reducer / fold", () => {
  it("folds create + patches; version increments; last-write wins per field", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: { status: "lead", value: 1 } }),
      ev(2, { _tag: "RecordVersionUpdated", patch: { value: 2 } }),
      ev(3, { _tag: "RecordVersionUpdated", patch: { status: "qualified" } }),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.state).toEqual({ status: "qualified", value: 2 })
      expect(result.right.version).toBe(2)
      expect(result.right.archivedAt).toBeNull()
    }
  })

  it("rejects a mutation before create", () => {
    expect(
      Either.isLeft(applyEvent(null, ev(1, { _tag: "RecordVersionUpdated", patch: {} }))),
    ).toBe(true)
  })

  it("rejects an event after delete (no undelete)", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "RecordVersionDeleted" }),
      ev(3, { _tag: "RecordVersionUpdated", patch: { a: 1 } }),
    ])
    expect(Either.isLeft(result)).toBe(true)
  })

  it("delete sets archivedAt and bumps version", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "RecordVersionDeleted" }, new Date(5)),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.version).toBe(1)
      expect(result.right.archivedAt).toEqual(new Date(5))
    }
  })

  it("archive sets archivedAt; restore clears it; version bumps each step", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: { a: 1 } }),
      ev(2, { _tag: "RecordVersionArchived" }, new Date(5)),
      ev(3, { _tag: "RecordVersionRestored" }),
      ev(4, { _tag: "RecordVersionUpdated", patch: { a: 2 } }),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.state).toEqual({ a: 2 })
      expect(result.right.version).toBe(3)
      expect(result.right.archivedAt).toBeNull()
    }
  })

  it("rejects a restore on a live (never-archived) recordVersion", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "RecordVersionRestored" }),
    ])
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a non-restore event while archived", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: {} }),
      ev(2, { _tag: "RecordVersionArchived" }),
      ev(3, { _tag: "RecordVersionUpdated", patch: { a: 1 } }),
    ])
    expect(Either.isLeft(result)).toBe(true)
  })

  it("empty stream folds to null", () => {
    const result = foldEvents([])
    expect(Either.isRight(result) && result.right === null).toBe(true)
  })

  it("an explicit null in a patch clears the field; create strips nulls", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: { a: 1, b: null } }),
      ev(2, { _tag: "RecordVersionUpdated", patch: { a: null, c: "x" } }),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.state).toEqual({ c: "x" })
      expect(result.right.version).toBe(1)
    }
  })

  it("folds the synthetic __labels key through create + patch (per-record labels)", () => {
    const result = foldEvents([
      ev(1, { _tag: "RecordVersionCreated", conceptId: "c", fields: { __labels: ["a"] } }),
      ev(2, { _tag: "RecordVersionUpdated", patch: { __labels: ["a", "b"] } }),
    ])
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result) && result.right) {
      expect(result.right.state.__labels).toEqual(["a", "b"])
      expect(result.right.version).toBe(1)
    }
  })
})
