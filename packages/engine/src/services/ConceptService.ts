import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { InstanceViewLayout } from "../domain/types"
import {
  ConceptInUse,
  ConceptNameConflict,
  ConceptNotFound,
  FieldNotFound,
  LabelNotFound,
  VersioningInUse,
} from "../errors"
import { EventStore } from "./EventStore"
import { LabelService } from "./LabelService"
import { OrgContext } from "./OrgContext"
import { type ConceptRow, toConcept } from "./rows"

/** Derive a stable system key from a display name (lowercase, alnum + underscore). */
const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "concept"

/** Manages concept definitions (the "types" — Account, Deal, …). */
export class ConceptService extends Effect.Service<ConceptService>()("engine/ConceptService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const labels = yield* LabelService

    const getByName = (name: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND name = ${name} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: name }))
        return toConcept(row)
      })

    const getById = (id: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: id }))
        return toConcept(row)
      })

    /** Look up a concept by its stable slug (the handle the app pins by). */
    const getBySlug = (slug: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND slug = ${slug} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: slug }))
        return toConcept(row)
      })

    /** Concepts ordered by name. Archived (archived_at set) are excluded unless
     *  `includeArchived`. With `withCounts`, each concept carries `itemCount` (its
     *  total instances, live + archived) — what blocks a purge — so the settings
     *  UI can show "N items" on archived concepts and never silently strand them. */
    const list = (
      opts: { readonly includeArchived?: boolean; readonly withCounts?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
        // Count ITEMS, not version rows: a versioned concept counts distinct
        // lineages (each item has ≥1 version); a non-versioned concept counts
        // instances exactly as before (1:1, so the two coincide). Both still count
        // live + archived, so the count keeps blocking a concept purge correctly.
        const countCol = opts.withCounts
          ? sql`, (CASE WHEN c.versioning_enabled
                    THEN (SELECT COUNT(DISTINCT i.item_id)::int FROM instances i WHERE i.org_id = c.org_id AND i.concept_id = c.id)
                    ELSE (SELECT COUNT(*)::int FROM instances i WHERE i.org_id = c.org_id AND i.concept_id = c.id)
                  END) AS item_count`
          : sql``
        const rows = yield* sql<ConceptRow>`
          SELECT c.*${countCol} FROM concepts c WHERE c.org_id = ${orgId}${liveOnly} ORDER BY c.name ASC`
        return rows.map(toConcept)
      })

    const create = (input: {
      readonly name: string
      // Optional plural display label; the UI create flow omits it (singular
      // only), but the seed supplies sensible plurals for the built-in concepts.
      readonly pluralName?: string | null
      readonly description?: string
      readonly icon?: string | null
      readonly color?: string | null
      // Connector-owned "managed concept" kind (e.g. "linear", "google.gmail");
      // null/omitted for a normal user concept. Set only by integration sync.
      readonly managedBy?: string | null
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // Only live concepts hold a name (the unique index is partial), so an
          // archived concept's name is free to reuse.
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM concepts
            WHERE org_id = ${orgId} AND name = ${input.name} AND archived_at IS NULL LIMIT 1`
          if (existing[0]) return yield* Effect.fail(new ConceptNameConflict({ name: input.name }))
          // Derive a stable, unique slug from the initial name (suffix on collision).
          const all = yield* sql<{ readonly slug: string }>`
            SELECT slug FROM concepts WHERE org_id = ${orgId}`
          const used = new Set(all.map((r) => r.slug))
          const base = slugify(input.name)
          let slug = base
          for (let n = 2; used.has(slug); n++) slug = `${base}_${n}`
          const rows = yield* sql<ConceptRow>`
            INSERT INTO concepts (org_id, slug, name, plural_name, description, icon, color, managed_by)
            VALUES (${orgId}, ${slug}, ${input.name}, ${input.pluralName?.trim() || null}, ${input.description ?? null}, ${input.icon ?? null}, ${input.color ?? null}, ${input.managedBy ?? null})
            RETURNING *`
          const concept = toConcept(rows[0]!)
          yield* events.append({
            subjectKind: "concept",
            subjectId: concept.id,
            eventType: "ConceptCreated",
            payload: { _tag: "ConceptCreated", name: concept.name },
          })
          return concept
        }),
      )

    /**
     * Edit a concept's description, rename it, and/or set its static/default
     * label-id sets. The app refers to concepts by id, so renaming is safe; the
     * (org, name) uniqueness constraint still holds, so a clashing new name
     * fails with ConceptNameConflict. Omitted label arrays are left unchanged
     * (so the name/description "Save" path never wipes the label sets).
     */
    const update = (input: {
      readonly id: string
      readonly description: string | null
      readonly name?: string
      // Omitted → left unchanged; explicit null / blank → cleared.
      readonly pluralName?: string | null
      // Omitted → left unchanged; explicit null → cleared.
      readonly icon?: string | null
      // Omitted → left unchanged; explicit null → cleared.
      readonly color?: string | null
      readonly staticLabelIds?: ReadonlyArray<string>
      readonly defaultLabelIds?: ReadonlyArray<string>
      // Toggle per-concept versioning. Enabling is always allowed (existing
      // instances are already 1-version published items). Disabling is blocked
      // while any item holds >1 version or an open draft.
      readonly versioningEnabled?: boolean
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const current = yield* getById(input.id)
          const name = input.name?.trim()
          const versioningEnabled =
            input.versioningEnabled === undefined
              ? current.versioningEnabled
              : input.versioningEnabled
          // Guard a disable: refuse if any item has multiple versions or a draft,
          // which would otherwise orphan versions with no defined "latest".
          if (current.versioningEnabled && versioningEnabled === false) {
            const multi = yield* sql<{ readonly count: number | string }>`
              SELECT COUNT(*)::int AS count FROM (
                SELECT item_id FROM instances
                WHERE org_id = ${orgId} AND concept_id = ${input.id}
                GROUP BY item_id
                HAVING COUNT(*) > 1 OR bool_or(version_status = 'draft')
              ) x`
            const multiVersionItemCount = Number(multi[0]?.count ?? 0)
            if (multiVersionItemCount > 0) {
              return yield* Effect.fail(
                new VersioningInUse({ conceptId: input.id, multiVersionItemCount }),
              )
            }
          }
          if (name && name !== current.name) {
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM concepts
              WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL AND id <> ${input.id}
              LIMIT 1`
            if (clash[0]) return yield* Effect.fail(new ConceptNameConflict({ name }))
          }
          // Reject any provided label id that isn't a live vocabulary entry.
          const provided = [...(input.staticLabelIds ?? []), ...(input.defaultLabelIds ?? [])]
          if (provided.length > 0) {
            const live = yield* labels.existingIds(provided)
            const missing = provided.find((id) => !live.has(id))
            if (missing) return yield* Effect.fail(new LabelNotFound({ labelId: missing }))
          }
          const finalName = name || current.name
          // Omitted → keep; provided → trim, treating blank as "cleared" (null).
          const pluralName =
            input.pluralName === undefined ? current.pluralName : input.pluralName?.trim() || null
          const icon = input.icon === undefined ? current.icon : input.icon
          const color = input.color === undefined ? current.color : input.color
          const staticIds = [...new Set(input.staticLabelIds ?? current.staticLabelIds)]
          const defaultIds = [...new Set(input.defaultLabelIds ?? current.defaultLabelIds)]
          // Bind the id arrays as JSON text + cast: `sql.json` serialises a
          // top-level array as a Postgres array literal (`{…}`), not jsonb.
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts
            SET description = ${input.description}, name = ${finalName},
                plural_name = ${pluralName}, icon = ${icon}, color = ${color},
                versioning_enabled = ${versioningEnabled},
                static_label_ids = ${JSON.stringify(staticIds)}::jsonb,
                default_label_ids = ${JSON.stringify(defaultIds)}::jsonb
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: input.id }))
          const concept = toConcept(row)
          yield* events.append({
            subjectKind: "concept",
            subjectId: concept.id,
            eventType: "ConceptUpdated",
            payload: {
              _tag: "ConceptUpdated",
              description: concept.description,
              ...(name ? { name: concept.name } : {}),
              ...(input.pluralName !== undefined ? { pluralName: concept.pluralName } : {}),
              ...(input.icon !== undefined ? { icon: concept.icon } : {}),
              ...(input.color !== undefined ? { color: concept.color } : {}),
              ...(input.versioningEnabled !== undefined
                ? { versioningEnabled: concept.versioningEnabled }
                : {}),
              ...(input.staticLabelIds ? { staticLabelIds: concept.staticLabelIds } : {}),
              ...(input.defaultLabelIds ? { defaultLabelIds: concept.defaultLabelIds } : {}),
            },
          })
          return concept
        }),
      )

    /** Set (or clear) this concept's org-wide default instance-detail layout.
     *  `null` clears the column → instances render the built-in default preset.
     *  Presentational config (like graph layouts), so it emits no event. Not
     *  admin-gated at the RPC boundary — any member may shape the layout. */
    const setInstanceView = (id: string, layout: InstanceViewLayout | null) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* getById(id) // 404 if missing / cross-org
          // sql.json serialises a top-level array as a Postgres array literal, but
          // the body is an object, so JSON.stringify + ::jsonb is safe here.
          const json = layout ? JSON.stringify(layout) : null
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts SET instance_view = ${json}::jsonb
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: id }))
          return toConcept(row)
        }),
      )

    /** Set (or clear) the field whose value is this concept's instance display
     *  label. `null` clears it (fallback to the first-text-field heuristic). Like
     *  `setInstanceView`, presentational config → emits no event. Validates the
     *  field belongs to a LIVE field of this concept (any kind; the picker limits
     *  to scalars, but a stale/relation id is rejected here as a guard). */
    const setTitleField = (id: string, titleFieldId: string | null) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* getById(id) // 404 if missing / cross-org
          if (titleFieldId) {
            const f = yield* sql<{ readonly id: string }>`
              SELECT id FROM fields
              WHERE org_id = ${orgId} AND concept_id = ${id} AND id = ${titleFieldId}
                AND archived_at IS NULL LIMIT 1`
            if (!f[0]) return yield* Effect.fail(new FieldNotFound({ fieldId: titleFieldId }))
          }
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts SET title_field_id = ${titleFieldId}
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: id }))
          return toConcept(row)
        }),
      )

    /** Archive a concept (soft, restorable): hides it from the live list but keeps
     *  the row and its fields/instances intact. Idempotent on an archived concept. */
    const archive = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* getById(id) // 404 if missing / cross-org
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts SET archived_at = COALESCE(archived_at, now())
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          yield* events.append({
            subjectKind: "concept",
            subjectId: id,
            eventType: "ConceptArchived",
            payload: { _tag: "ConceptArchived" },
          })
          return toConcept(rows[0]!)
        }),
      )

    /** Restore an archived concept. Fails ConceptNameConflict if its display name
     *  was meanwhile taken by a live concept (the name index is partial). */
    const restore = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept = yield* getById(id)
          const clash = yield* sql<{ readonly id: string }>`
            SELECT id FROM concepts
            WHERE org_id = ${orgId} AND name = ${concept.name} AND archived_at IS NULL
              AND id <> ${id} LIMIT 1`
          if (clash[0]) return yield* Effect.fail(new ConceptNameConflict({ name: concept.name }))
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts SET archived_at = NULL WHERE org_id = ${orgId} AND id = ${id}
            RETURNING *`
          yield* events.append({
            subjectKind: "concept",
            subjectId: id,
            eventType: "ConceptRestored",
            payload: { _tag: "ConceptRestored" },
          })
          return toConcept(rows[0]!)
        }),
      )

    /** Permanently delete a concept and its field defs. Refused while ANY instance
     *  (live or archived) still references it — archive or remove those first. */
    const purge = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept = yield* getById(id)
          const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM instances
            WHERE org_id = ${orgId} AND concept_id = ${id}`
          const instanceCount = Number(counts[0]?.count ?? 0)
          if (instanceCount > 0) {
            return yield* Effect.fail(new ConceptInUse({ concept: concept.name, instanceCount }))
          }
          yield* sql`DELETE FROM fields WHERE org_id = ${orgId} AND concept_id = ${id}`
          // Zero instances ⇒ any remaining items rows are empty lineages; clear
          // them so the concept row's FK doesn't block the delete.
          yield* sql`DELETE FROM items WHERE org_id = ${orgId} AND concept_id = ${id}`
          // Record dashboards are per-concept templates (logical FK, no DB cascade);
          // drop them so they don't orphan invisibly when the concept goes.
          yield* sql`DELETE FROM dashboards
            WHERE org_id = ${orgId} AND concept_id = ${id} AND kind = 'record'`
          yield* sql`DELETE FROM concepts WHERE org_id = ${orgId} AND id = ${id}`
          yield* events.append({
            subjectKind: "concept",
            subjectId: id,
            eventType: "ConceptDeleted",
            payload: { _tag: "ConceptDeleted" },
          })
          return concept
        }),
      )

    return {
      create,
      getByName,
      getById,
      getBySlug,
      list,
      update,
      setInstanceView,
      setTitleField,
      archive,
      restore,
      purge,
    } as const
  }),
  dependencies: [EventStore.Default, LabelService.Default],
}) {}
