import { PgClient } from "@effect/sql-pg"
import { Clock, Effect } from "effect"
import type { EngineEvent, EventPayload, Id, SubjectKind } from "../domain/types"
import { OrgContext } from "./OrgContext"
import { type EventRow, toEvent } from "./rows"

export interface AppendInput {
  readonly subjectKind: SubjectKind
  readonly subjectId: Id
  readonly eventType: string
  readonly payload: EventPayload
}

/**
 * The low-level event primitive: the ONLY reader/writer of the `events` table.
 * `append` assumes it is called inside a `sql.withTransaction` (so the event and
 * the projection write commit atomically). It stamps `actor` from OrgContext and
 * `occurred_at` from the Effect Clock (so TestClock controls event time).
 */
export class EventStore extends Effect.Service<EventStore>()("engine/EventStore", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    const append = (input: AppendInput): Effect.Effect<EngineEvent, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId, actor } = yield* OrgContext
        const millis = yield* Clock.currentTimeMillis
        const occurredAt = new Date(millis)
        const rows = yield* sql<{ readonly id: number | string; readonly occurred_at: Date }>`
          INSERT INTO events (org_id, occurred_at, actor, subject_kind, subject_id, event_type, payload)
          VALUES (${orgId}, ${occurredAt}, ${actor}, ${input.subjectKind}, ${input.subjectId}, ${input.eventType}, ${sql.json(input.payload)})
          RETURNING id, occurred_at`
        const row = rows[0]!
        return {
          id: Number(row.id),
          orgId,
          occurredAt: row.occurred_at,
          actor,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          eventType: input.eventType,
          payload: input.payload,
        }
      }).pipe(Effect.orDie)

    const readStream = (subjectId: Id, opts?: { readonly upToEventId?: number }) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows =
          opts?.upToEventId !== undefined
            ? yield* sql<EventRow>`
                SELECT * FROM events
                WHERE subject_id = ${subjectId} AND org_id = ${orgId} AND id <= ${opts.upToEventId}
                ORDER BY id ASC`
            : yield* sql<EventRow>`
                SELECT * FROM events
                WHERE subject_id = ${subjectId} AND org_id = ${orgId}
                ORDER BY id ASC`
        return rows.map(toEvent)
      }).pipe(Effect.orDie)

    const readAllForOrg = (opts?: { readonly limit?: number }) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const limit = opts?.limit ?? 200
        const rows = yield* sql<EventRow>`
          SELECT * FROM events WHERE org_id = ${orgId} ORDER BY id DESC LIMIT ${limit}`
        return rows.map(toEvent)
      }).pipe(Effect.orDie)

    return { append, readStream, readAllForOrg } as const
  }),
}) {}
