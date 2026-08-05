import { PgClient } from "@effect/sql-pg"
import { Clock, Effect } from "effect"
import type { EngineEvent, EventPayload, Id, OrgId, SubjectKind } from "../domain/types"
import { OrgContext } from "./OrgContext"
import { type EventRow, toEvent } from "./rows"

/** The single Postgres LISTEN/NOTIFY channel the live-sync stream rides on. */
export const EVENT_CHANNEL = "km_events"

/**
 * The metadata-only notification emitted on every appended event. NO field
 * values — just enough for a client to route a refetch. Kept tiny (well under
 * the 8 KB NOTIFY payload cap) and leak-free.
 */
export interface EventEnvelope {
  readonly org: OrgId
  readonly id: number
  readonly at: number
  readonly kind: SubjectKind
  readonly subjectId: Id
  readonly type: string
  /** Concept id for record version events (routes to the id-keyed collection); null otherwise. */
  readonly conceptId: string | null
  /** Concept name for record version events (used by the by-name dashboard routing); null otherwise. */
  readonly concept: string | null
  /**
   * Who caused the event (= the `events.actor` column): a user id, or a
   * `system:*` actor for a server tick.
   *
   * Carried so the automation runner can enforce its one-hop guard WITHOUT a
   * database read per delivered event — an event whose actor is an automation
   * (`system:automation:<id>`) must never trigger another one. Identity metadata
   * only, never field values, so the envelope stays leak-free and well under the
   * 8 KB NOTIFY cap.
   */
  readonly actor: string | null
}

export interface AppendInput {
  readonly subjectKind: SubjectKind
  readonly subjectId: Id
  readonly eventType: string
  readonly payload: EventPayload
  /** Concept id carried into the NOTIFY envelope for record version events. */
  readonly conceptId?: string
  /** Concept name carried into the NOTIFY envelope for record version events. */
  readonly conceptName?: string
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
        // Emit the live-sync envelope on the SAME (transaction) connection via a
        // templated statement — so Postgres delivers it only on COMMIT and drops
        // it on ROLLBACK (a bare `sql.notify` would fire immediately on a separate
        // pooled connection). Metadata only; never the payload.
        const envelope: EventEnvelope = {
          org: orgId,
          id: Number(row.id),
          at: occurredAt.getTime(),
          kind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.eventType,
          conceptId: input.conceptId ?? null,
          concept: input.conceptName ?? null,
          actor,
        }
        yield* sql`SELECT pg_notify(${EVENT_CHANNEL}, ${JSON.stringify(envelope)})`
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

    /**
     * A larger/filterable recent-events window (powers the dashboard Trend +
     * Activity widgets). Optional `since` lower-bounds occurred_at; optional
     * `conceptId` restricts to that concept's record version events (joined via
     * `record_versions.concept_id`). Newest first, server-clamped to ≤2000.
     */
    const listEvents = (opts?: {
      readonly since?: Date
      readonly limit?: number
      readonly conceptId?: string
    }) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const limit = Math.min(opts?.limit ?? 500, 2000)
        const since = opts?.since ?? null
        const rows = opts?.conceptId
          ? yield* sql<EventRow>`
              SELECT e.* FROM events e
              JOIN record_versions i ON i.id = e.subject_id
              WHERE e.org_id = ${orgId} AND e.subject_kind = 'recordVersion'
                AND i.concept_id = ${opts.conceptId}
                AND (${since}::timestamptz IS NULL OR e.occurred_at >= ${since})
              ORDER BY e.id DESC LIMIT ${limit}`
          : yield* sql<EventRow>`
              SELECT * FROM events
              WHERE org_id = ${orgId}
                AND (${since}::timestamptz IS NULL OR occurred_at >= ${since})
              ORDER BY id DESC LIMIT ${limit}`
        return rows.map(toEvent)
      }).pipe(Effect.orDie)

    return { append, readStream, readAllForOrg, listEvents } as const
  }),
}) {}
