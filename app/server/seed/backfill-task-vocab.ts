import "../env"
import { Effect } from "effect"
import { TaskPriorityService, TaskStatusService } from "#engine"
import { runEngineOrThrow } from "../runtime"
import { defaultTaskPriorities, defaultTaskStatuses } from "./spec"

/**
 * CLI: `bun server/seed/backfill-task-vocab.ts <orgId>` — seed ONLY the task
 * status + priority defaults into an org that predates the annotation
 * substrate. Idempotent (ensureDefaults no-ops when any exist); never touches
 * concepts, so it is safe for orgs where re-running the full seed is not.
 */
const orgId = process.argv[2]
if (!orgId) {
  console.error("usage: bun server/seed/backfill-task-vocab.ts <orgId>")
  process.exit(1)
}

const result = await runEngineOrThrow(
  { orgId, actor: "system" },
  Effect.gen(function* () {
    const statuses = yield* TaskStatusService
    const priorities = yield* TaskPriorityService
    const s = yield* statuses.ensureDefaults(defaultTaskStatuses)
    const p = yield* priorities.ensureDefaults(defaultTaskPriorities)
    return { statuses: s.length, priorities: p.length }
  }),
)
console.log(`org ${orgId}: ${result.statuses} statuses, ${result.priorities} priorities`)
process.exit(0)
