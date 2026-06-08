import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Label } from "../domain/types"
import { LabelNameConflict, LabelNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type LabelRow, toLabel } from "./rows"

/**
 * Manages the org-wide, flat label vocabulary. A label is keyed by `id`; its
 * `name`/`color` are freely editable (everything else references the id, so a
 * rename needs no backfill) and it is soft-deleted so historical references on
 * instances / concepts stay resolvable. Mirrors `ConceptService`.
 */
export class LabelService extends Effect.Service<LabelService>()("engine/LabelService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore

    const getById = (id: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<LabelRow>`
          SELECT * FROM labels WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new LabelNotFound({ labelId: id }))
        return toLabel(row)
      })

    /** Live (non-deleted) labels, ordered by name — the vocabulary pickers see. */
    const list = () =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<LabelRow>`
          SELECT * FROM labels
          WHERE org_id = ${orgId} AND deleted_at IS NULL
          ORDER BY name ASC`
        return rows.map(toLabel)
      })

    /** Resolve a set of ids to their live labels, sorted alphabetically by name
     *  (missing / soft-deleted ids are dropped — mirrors how a deleted field
     *  drops out of display while its id stays harmlessly on instance state). */
    const resolve = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<Label>
        const { orgId } = yield* OrgContext
        const rows = yield* sql<LabelRow>`
          SELECT * FROM labels WHERE org_id = ${orgId} AND deleted_at IS NULL`
        const byId = new Map(rows.map((r) => [r.id, toLabel(r)] as const))
        return ids
          .flatMap((id) => {
            const l = byId.get(id)
            return l ? [l] : []
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      })

    /** Which of `ids` are live labels in this org (for write-time validation). */
    const existingIds = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return new Set<string>()
        const { orgId } = yield* OrgContext
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM labels WHERE org_id = ${orgId} AND deleted_at IS NULL`
        return new Set(rows.map((r) => r.id))
      })

    const create = (input: {
      readonly name: string
      readonly color?: string | null
      readonly primary?: boolean
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const name = input.name.trim()
          const color = input.color ?? null
          const primary = input.primary ?? false
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM labels
            WHERE org_id = ${orgId} AND name = ${name} AND deleted_at IS NULL LIMIT 1`
          if (existing[0]) return yield* Effect.fail(new LabelNameConflict({ name }))
          const rows = yield* sql<LabelRow>`
            INSERT INTO labels (org_id, name, color, is_primary)
            VALUES (${orgId}, ${name}, ${color}, ${primary})
            RETURNING *`
          const label = toLabel(rows[0]!)
          yield* events.append({
            subjectKind: "label",
            subjectId: label.id,
            eventType: "LabelCreated",
            payload: {
              _tag: "LabelCreated",
              name: label.name,
              color: label.color,
              primary: label.primary,
            },
          })
          return label
        }),
      )

    /** Rename, recolor, and/or toggle the primary flag. Refs are by id, so this
     *  propagates with no backfill. */
    const rename = (input: {
      readonly id: string
      readonly name?: string
      readonly color?: string | null
      readonly primary?: boolean
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const current = yield* getById(input.id)
          const name = input.name?.trim() || current.name
          const color = input.color === undefined ? current.color : input.color
          const primary = input.primary === undefined ? current.primary : input.primary
          if (name !== current.name) {
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM labels
              WHERE org_id = ${orgId} AND name = ${name} AND deleted_at IS NULL AND id <> ${input.id}
              LIMIT 1`
            if (clash[0]) return yield* Effect.fail(new LabelNameConflict({ name }))
          }
          const rows = yield* sql<LabelRow>`
            UPDATE labels SET name = ${name}, color = ${color}, is_primary = ${primary}
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new LabelNotFound({ labelId: input.id }))
          const label = toLabel(row)
          yield* events.append({
            subjectKind: "label",
            subjectId: label.id,
            eventType: "LabelRenamed",
            payload: {
              _tag: "LabelRenamed",
              name: label.name,
              color: label.color,
              primary: label.primary,
            },
          })
          return label
        }),
      )

    /** Soft-delete: the id stays resolvable, but the label drops out of pickers
     *  and live displays (stale ids on instances/concepts are filtered on read). */
    const remove = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const label = yield* getById(id)
          yield* sql`UPDATE labels SET deleted_at = now() WHERE org_id = ${orgId} AND id = ${id}`
          yield* events.append({
            subjectKind: "label",
            subjectId: id,
            eventType: "LabelDeleted",
            payload: { _tag: "LabelDeleted" },
          })
          return label
        }),
      )

    return { list, resolve, existingIds, getById, create, rename, remove } as const
  }),
  dependencies: [EventStore.Default],
}) {}
