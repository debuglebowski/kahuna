import { randomUUID } from "node:crypto"
import type { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { AnnotationService, type EngineServices, type OrgContext } from "#engine"
import { runEngineOrThrow, systemScope } from "./runtime"
import * as uc from "./use-cases"

/**
 * The use-case half of version approval: a request opens a to-do for the
 * approver in the same transaction, and resolving the request closes it —
 * `done` on approve, `cancelled` on reject / withdraw. (The engine half — who
 * may approve, the lock, the fold — is engine/test/version-release.test.ts.)
 */

const runAs = <A, E>(
  orgId: string,
  actor: string,
  eff: Effect.Effect<A, E, OrgContext | EngineServices | PgClient.PgClient>,
) => runEngineOrThrow(systemScope(orgId, actor), eff)

type V = { id: string; recordId: string; version: number; release: { pending: unknown } }

const setup = async () => {
  const org = randomUUID()
  await runAs(
    org,
    "kalle",
    uc.createTaskStatus({ name: "Todo", category: "todo", isDefault: true }),
  )
  const done = (await runAs(org, "kalle", uc.createTaskStatus({ name: "Done", category: "done" })))
    .id
  const cancelled = (
    await runAs(org, "kalle", uc.createTaskStatus({ name: "Cancelled", category: "cancelled" }))
  ).id
  const concept = (await runAs(org, "kalle", uc.createConcept("Policy"))) as { id: string }
  await runAs(
    org,
    "kalle",
    uc.updateConcept(concept.id, {
      description: null,
      versioningEnabled: true,
      approvalPolicy: "all",
    }),
  )
  const draft = (await runAs(org, "kalle", uc.createRecord(concept.id, {}))) as V
  return { org, draft, done, cancelled }
}

const task = (org: string, id: string) =>
  runAs(
    org,
    "kalle",
    Effect.flatMap(AnnotationService, (a) => a.getTask(id)),
  )

const request = (org: string, draft: V) =>
  runAs(
    org,
    "kalle",
    uc.publishVersion({
      id: draft.id,
      expectedVersion: draft.version,
      name: "2.0.0",
      approverId: "sara",
    }),
  )

describe("version approval (use-cases)", () => {
  it("request opens the approver's task; approve publishes and closes it as done", async () => {
    const { org, draft, done } = await setup()
    const req = await request(org, draft)
    const taskId = req.release.pending?.taskId
    expect(taskId).toBeTruthy()
    const t = await task(org, taskId!)
    expect(t.assignee).toBe("sara")
    expect(t.subjectId).toBe(draft.recordId)
    expect(t.title).toContain("2.0.0")

    const approved = await runAs(org, "sara", uc.approveVersion(draft.id))
    expect(approved.versionStatus).toBe("published")
    expect(approved.release.approvedBy).toBe("sara")
    expect(approved.release.publishedBy).toBe("kalle")
    expect((await task(org, taskId!)).statusId).toBe(done)
  })

  it("reject and withdraw close the task as cancelled", async () => {
    const { org, draft, cancelled } = await setup()
    const first = await request(org, draft)
    const rejected = await runAs(org, "sara", uc.rejectVersion(draft.id, "No"))
    expect((await task(org, first.release.pending!.taskId!)).statusId).toBe(cancelled)

    const second = await request(org, { ...draft, version: rejected.version })
    await runAs(org, "kalle", uc.withdrawApproval(draft.id))
    expect((await task(org, second.release.pending!.taskId!)).statusId).toBe(cancelled)
  })

  it("a refused request leaves no orphan task", async () => {
    const { org, draft } = await setup()
    // Self-approval is refused inside the same transaction that opened the task.
    await expect(
      runAs(
        org,
        "kalle",
        uc.publishVersion({
          id: draft.id,
          expectedVersion: draft.version,
          approverId: "kalle",
        }),
      ),
    ).rejects.toBeTruthy()
    const tasks = await runAs(org, "kalle", uc.listTasks({ subjectId: draft.recordId }))
    expect(tasks).toHaveLength(0)
  })
})
