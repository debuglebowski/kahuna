import { PgClient } from "@effect/sql-pg"
import { Clock, Effect } from "effect"
import { type DecayParams, decay } from "../computed/decay"
import { type MomentumParams, momentum } from "../computed/momentum"
import type { Field, RecordVersion } from "../domain/types"
import { FieldService } from "./FieldService"
import { OrgContext } from "./OrgContext"

/**
 * Read-time computed fields (decay, momentum). Never stored — merged into a
 * COPY of the record version using `now` from the Effect Clock (so they always
 * reflect the current moment, and TestClock makes them deterministic in tests).
 */
export class ComputedFields extends Effect.Service<ComputedFields>()("engine/ComputedFields", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const fields = yield* FieldService

    /**
     * Deal --forRel--> Account; Interactions --onRel--> Account; collect their
     * dateField. `forRel`/`onRel` are relation **field ids**; `dateField` is the
     * **field id** of the date field on the related concept.
     */
    const gatherDates = (
      recordVersionId: string,
      forRel: string,
      onRel: string,
      dateField: string,
    ) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<{ readonly occurred_on: string | null }>`
          SELECT (i.state->>${dateField}) AS occurred_on
          FROM relations r_for
          JOIN relations r_on
            ON r_on.to_id = r_for.to_id AND r_on.org_id = r_for.org_id
            AND r_on.field_id = ${onRel} AND r_on.archived_at IS NULL
          JOIN record_versions i
            ON i.id = r_on.from_id AND i.org_id = r_for.org_id AND i.archived_at IS NULL
          WHERE r_for.org_id = ${orgId} AND r_for.from_id = ${recordVersionId}
            AND r_for.field_id = ${forRel} AND r_for.archived_at IS NULL
            AND (i.state->>${dateField}) IS NOT NULL`
        return rows
          .map((r) => r.occurred_on)
          .filter((s): s is string => !!s)
          .map((s) => new Date(s))
      })

    /**
     * Fill in a concept's computed fields.
     *
     * `defs` is an optional pre-loaded field list. Without it this does one
     * `listFields` PER INSTANCE, and `listRecords` decorates every row of a
     * concept (capped at 50 000) — a real N+1 on the hottest read in the app. Every
     * row of one `listRecords` call shares a concept, so the caller can load the
     * defs once and pass them here.
     */
    const decorate = (recordVersion: RecordVersion, preloaded?: ReadonlyArray<Field>) =>
      Effect.gen(function* () {
        const defs = preloaded ?? (yield* fields.listFields(recordVersion.conceptId))
        const computed = defs.filter((d) => d.kind === "computed")
        if (computed.length === 0) return recordVersion

        const now = new Date(yield* Clock.currentTimeMillis)
        const state = { ...recordVersion.state }
        for (const def of computed) {
          const params = def.config.params ?? {}
          // Relation/date refs are field ids, resolved at field-creation time.
          const forRel = params.forRelation as string | undefined
          const onRel = params.onRelation as string | undefined
          const dateField = params.dateField as string | undefined
          const dates =
            forRel && onRel && dateField
              ? yield* gatherDates(recordVersion.id, forRel, onRel, dateField)
              : []
          if (def.config.computedKind === "decay") {
            state[def.id] = decay(dates, now, params as DecayParams, recordVersion.createdAt)
          } else if (def.config.computedKind === "momentum") {
            state[def.id] = momentum(dates, now, params as MomentumParams)
          }
        }
        return { ...recordVersion, state } satisfies RecordVersion
      })

    return { decorate } as const
  }),
  dependencies: [FieldService.Default],
}) {}
