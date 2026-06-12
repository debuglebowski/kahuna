import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { RichTextValue } from "../domain/richtext"
import { AnnotationService } from "../services/AnnotationService"
import { TaskPriorityService } from "../services/TaskPriorityService"
import { TaskStatusService } from "../services/TaskStatusService"
import { newOrgId, testLayer } from "./harness"

/** Seed the canonical status set; returns the ids by category for transitions. */
const seedStatuses = Effect.gen(function* () {
  const statuses = yield* TaskStatusService
  const todo = yield* statuses.create({ name: "Todo", category: "todo", isDefault: true })
  const active = yield* statuses.create({ name: "In progress", category: "active" })
  const done = yield* statuses.create({ name: "Done", category: "done" })
  const cancelled = yield* statuses.create({ name: "Cancelled", category: "cancelled" })
  return { todo, active, done, cancelled }
})

const doc = (text: string): RichTextValue => ({
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  text,
})

describe("tasks: completedAt transitions", () => {
  it.effect("set on entering done, kept across done→done, cleared on reopen", () =>
    Effect.gen(function* () {
      const { todo, done } = yield* seedStatuses
      const statuses = yield* TaskStatusService
      const done2 = yield* statuses.create({ name: "Shipped", category: "done" })
      const tasks = yield* AnnotationService

      let t = yield* tasks.createTask({ subjectId: null, title: "ship it" })
      expect(t.completedAt).toBeNull()

      t = yield* tasks.setTaskStatus({ id: t.id, expectedVersion: t.version, statusId: done.id })
      expect(t.completedAt).not.toBeNull()
      const firstCompleted = t.completedAt

      // done → done keeps the original completion time.
      t = yield* tasks.setTaskStatus({ id: t.id, expectedVersion: t.version, statusId: done2.id })
      expect(t.completedAt?.getTime()).toBe(firstCompleted?.getTime())

      // Reopening clears it.
      t = yield* tasks.setTaskStatus({ id: t.id, expectedVersion: t.version, statusId: todo.id })
      expect(t.completedAt).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("cancelled closes without completing — completedAt stays null", () =>
    Effect.gen(function* () {
      const { cancelled } = yield* seedStatuses
      const tasks = yield* AnnotationService
      let t = yield* tasks.createTask({ subjectId: null, title: "won't do" })
      t = yield* tasks.setTaskStatus({
        id: t.id,
        expectedVersion: t.version,
        statusId: cancelled.id,
      })
      expect(t.completedAt).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("tasks: priorities", () => {
  it.effect("create/list/reorder; name conflicts; archive blocked while tasks reference it", () =>
    Effect.gen(function* () {
      yield* seedStatuses
      const priorities = yield* TaskPriorityService
      const tasks = yield* AnnotationService

      const urgent = yield* priorities.create({ name: "Urgent", color: "#ef4444" })
      const low = yield* priorities.create({ name: "Low" })
      expect((yield* priorities.list()).map((p) => p.name)).toEqual(["Urgent", "Low"])

      const dup = yield* priorities.create({ name: "Urgent" }).pipe(Effect.flip)
      expect(dup._tag).toBe("TaskPriorityNameConflict")

      const t = yield* tasks.createTask({
        subjectId: null,
        title: "hot",
        priorityId: urgent.id,
      })
      expect(t.priorityId).toBe(urgent.id)

      const blocked = yield* priorities.archive(urgent.id).pipe(Effect.flip)
      expect(blocked._tag).toBe("TaskPriorityInUse")

      // Clearing the priority releases the archive guard.
      yield* tasks.updateTask({ id: t.id, expectedVersion: t.version, priorityId: null })
      const archived = yield* priorities.archive(urgent.id)
      expect(archived.archivedAt).not.toBeNull()

      // An archived priority is rejected at write time.
      const stale = yield* tasks
        .createTask({ subjectId: null, title: "x", priorityId: urgent.id })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("TaskPriorityNotFound")

      yield* priorities.reorder([
        { id: low.id, position: 0 },
        { id: urgent.id, position: 1 },
      ])
      expect((yield* priorities.list()).map((p) => p.id)).toEqual([low.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("tasks: description / labels", () => {
  it.effect("description text is re-derived server-side; null clears; junk rejected", () =>
    Effect.gen(function* () {
      yield* seedStatuses
      const tasks = yield* AnnotationService

      // The client's `text` is never trusted — the doc is the source of truth.
      const lying = { ...doc("real words"), text: "LIES" }
      let t = yield* tasks.createTask({ subjectId: null, title: "d", description: lying })
      expect(t.description?.text).toBe("real words")

      t = yield* tasks.updateTask({ id: t.id, expectedVersion: t.version, description: null })
      expect(t.description).toBeNull()

      const bad = yield* tasks
        .updateTask({
          id: t.id,
          expectedVersion: t.version,
          description: { nope: true } as unknown as RichTextValue,
        })
        .pipe(Effect.flip)
      expect(bad._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("labelIds round-trip and replace wholesale on update", () =>
    Effect.gen(function* () {
      yield* seedStatuses
      const tasks = yield* AnnotationService
      let t = yield* tasks.createTask({ subjectId: null, title: "l", labelIds: ["a-id", "b-id"] })
      expect(t.labelIds).toEqual(["a-id", "b-id"])
      t = yield* tasks.updateTask({ id: t.id, expectedVersion: t.version, labelIds: ["c-id"] })
      expect(t.labelIds).toEqual(["c-id"])
      // Untouched on unrelated updates.
      t = yield* tasks.updateTask({ id: t.id, expectedVersion: t.version, title: "renamed" })
      expect(t.labelIds).toEqual(["c-id"])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("tasks: snooze + blocked", () => {
  it.effect("snooze sets/clears snoozedUntil; junk dates rejected", () =>
    Effect.gen(function* () {
      yield* seedStatuses
      const tasks = yield* AnnotationService
      let t = yield* tasks.createTask({ subjectId: null, title: "s" })

      const until = new Date(Date.now() + 86_400_000).toISOString()
      t = yield* tasks.snoozeTask({ id: t.id, expectedVersion: t.version, until })
      expect(t.snoozedUntil).not.toBeNull()

      t = yield* tasks.snoozeTask({ id: t.id, expectedVersion: t.version, until: null })
      expect(t.snoozedUntil).toBeNull()

      const bad = yield* tasks
        .snoozeTask({ id: t.id, expectedVersion: t.version, until: "not-a-date" })
        .pipe(Effect.flip)
      expect(bad._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("block carries reason + task link; self/missing links rejected; unblock clears", () =>
    Effect.gen(function* () {
      yield* seedStatuses
      const tasks = yield* AnnotationService
      const blocker = yield* tasks.createTask({ subjectId: null, title: "the blocker" })
      let t = yield* tasks.createTask({ subjectId: null, title: "b" })

      const self = yield* tasks
        .setTaskBlocked({
          id: t.id,
          expectedVersion: t.version,
          blocked: { taskId: t.id },
        })
        .pipe(Effect.flip)
      expect(self._tag).toBe("FieldValidationError")

      t = yield* tasks.setTaskBlocked({
        id: t.id,
        expectedVersion: t.version,
        blocked: { reason: "waiting", taskId: blocker.id },
      })
      expect(t.blockedAt).not.toBeNull()
      expect(t.blockedReason).toBe("waiting")
      expect(t.blockedByTaskId).toBe(blocker.id)
      const blockedAt = t.blockedAt

      // Editing the reason while blocked keeps the original block time.
      t = yield* tasks.setTaskBlocked({
        id: t.id,
        expectedVersion: t.version,
        blocked: { reason: "still waiting" },
      })
      expect(t.blockedAt?.getTime()).toBe(blockedAt?.getTime())
      expect(t.blockedByTaskId).toBeNull()

      t = yield* tasks.setTaskBlocked({ id: t.id, expectedVersion: t.version, blocked: null })
      expect(t.blockedAt).toBeNull()
      expect(t.blockedReason).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
