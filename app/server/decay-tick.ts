import { PgClient } from "@effect/sql-pg"
import { InstanceService, OrgContext, QueryService } from "#engine"
import { Duration, Effect, Schedule } from "effect"
import { AppRuntime } from "./runtime"

/**
 * Server decay tick: periodically detect time-based decay band crossings and
 * turn them into real `ComputedBandChanged` events (via InstanceService.
 * recomputeBands), so they fan out over the SSE pipeline to every user and
 * become an automation hook. Single in-process scheduler, supervised.
 *
 * recomputeBands no-ops on instances whose concept has no decay field, so the
 * scan narrows to concepts that declare one — discovered generically from the
 * field defs (no hardcoded concept names). Bands are day-resolution, so an
 * hourly default is plenty.
 */

const TICK_ACTOR = "system:decay-tick"

const runForOrg = (orgId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const query = yield* QueryService
    const instances = yield* InstanceService
    // Every concept that declares a decay computed field, whatever it's named.
    const decayConcepts = yield* sql<{ readonly concept_id: string }>`
      SELECT DISTINCT concept_id FROM fields
      WHERE org_id = ${orgId} AND kind = 'computed' AND (config->>'computedKind') = 'decay'`
    for (const { concept_id } of decayConcepts) {
      const rows = yield* query.findInstances({ conceptId: concept_id, limit: 1000 })
      const active = rows.filter((r) => r.state.status !== "won" && r.state.status !== "lost")
      for (const r of active) {
        yield* instances.recomputeBands(r.id).pipe(Effect.catchAllCause(() => Effect.void))
      }
    }
  }).pipe(
    Effect.provideService(OrgContext, { orgId, actor: TICK_ACTOR }),
    // An org with no decay concepts just gets skipped.
    Effect.catchAllCause(() => Effect.void),
  )

const tickOnce = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const orgs = yield* sql<{ org_id: string }>`
    SELECT DISTINCT org_id FROM instances WHERE archived_at IS NULL`
  yield* Effect.forEach(orgs, (o) => runForOrg(o.org_id), { discard: true })
})

let started = false

/** Start the periodic decay tick (idempotent). Called from index.ts. */
export const startDecayTick = (): void => {
  if (started) return
  started = true
  const intervalMs = Number(process.env.DECAY_TICK_INTERVAL_MS ?? 3_600_000)
  AppRuntime.runFork(
    tickOnce.pipe(
      Effect.tapErrorCause((cause) => Effect.logError("decay tick error", cause)),
      Effect.catchAllCause(() => Effect.void),
      Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
    ),
  )
}
