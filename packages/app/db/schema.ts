import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * The engine meta-schema — the ENTIRE fixed schema. "Account", "Deal", etc. are
 * rows in `concepts`/`fields`, never tables. `events` is the source of truth;
 * `record_versions.state` / `relations` are projections derived from it.
 *
 * `org_id` and `actor` are logical foreign keys into BetterAuth-owned identity
 * tables (organization.id / user.id), which are migrated separately — so no
 * Drizzle-level FK is declared for them.
 */

export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Stable, immutable system key (derived from the initial name); the app pins
    // specific concepts by slug, so `name` is freely renameable.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    // Optional plural display label (e.g. name "Company" → "Companies"). The
    // sidebar prefers it, falling back to `name`; only the singular is asked for
    // at creation, so this stays null until set in the concept settings drawer.
    pluralName: text("plural_name"),
    description: text("description"),
    // Optional display glyph: a literal emoji (e.g. "🏢") or a curated lucide
    // icon name prefixed "lucide:" (e.g. "lucide:Building2"); null renders none.
    icon: text("icon"),
    // Optional display color (hex, from the same pill palette as labels); used
    // to tint the concept wherever record versions are visualised. Null = neutral.
    color: text("color"),
    // Connector-owned "managed concept" marker: a typed integration kind (e.g.
    // "linear", "google.gmail", "google.calendar") when this concept's schema +
    // record versions are owned by an integration sync, else null for a normal user
    // concept. Drives read-only guards (at the RPC boundary) and an opinionated
    // record version detail view. Keyed by this kind, never by the concept name.
    managedBy: text("managed_by"),
    // Label-id arrays drawn from the org-wide `labels` vocabulary. `static` =
    // inherited by every record version (read-time, never written per record); `default`
    // = snapshotted onto each new record version's `state.__labels` at creation time.
    // Stored as ids (not names) so a label rename needs no backfill.
    staticLabelIds: jsonb("static_label_ids").notNull().default(sql`'[]'::jsonb`),
    defaultLabelIds: jsonb("default_label_ids").notNull().default(sql`'[]'::jsonb`),
    // Opt-in "Versioning": when true, this concept's records hold multiple draft→
    // published versions (each a first-class `record_versions` row sharing an `records`
    // lineage), and references may pin a specific published version. When false
    // (default) the concept behaves exactly as the plain 1-record version-per-record model.
    versioningEnabled: boolean("versioning_enabled").notNull().default(false),
    // How far back edits reach on a versioned concept ('draft' | 'any'); only
    // meaningful when `versioning_enabled`. 'draft' (default) = a published
    // version is frozen, edits need a fresh draft. 'any' = any published version
    // may be AMENDED in place — a pinned reference points at a version row, so an
    // amendment is visible to everyone referencing it (that's the point: an
    // erratum). Amendments stay auditable: every write is an appended event.
    editReach: text("edit_reach").notNull().default("draft"),
    // Opt-in "single record": when true this concept holds exactly ONE record —
    // always present (created in the same transaction that flips the flag) and
    // neither archivable nor purgeable while the flag is on. Enforced at the RECORD
    // level (at most one live `records` lineage), which keeps it orthogonal to
    // `versioning_enabled`, where one lineage legitimately holds N version rows.
    // Makes the concept addressable without a uuid (routed at /c/<slug>).
    singleRecord: boolean("single_record").notNull().default(false),
    // Org-wide default detail layout for this concept's record versions: a 12-col grid
    // of tiles (`{ tiles: [...] }`), the same shape as the view-prefs custom
    // layouts. Null = render the built-in default preset. Set in concept
    // settings → Layout; every record version of the concept renders it (there is no
    // per-user layout switch).
    recordView: jsonb("record_view"),
    // The field whose value is this concept's record version display label ("title").
    // An explicit pick (any scalar field id) replaces the old "first text field"
    // heuristic; null falls back to it only for an as-yet-unconfigured concept.
    // For managed concepts the integration sets this and the UI locks it. No FK:
    // the value lives in record version state regardless, so a dropped field still
    // resolves (and avoids a delete-order constraint).
    titleFieldId: uuid("title_field_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Archive marker (mirrors `fields`/`labels`): a non-null value hides the
    // concept from the live list but keeps the row (restorable). A true *delete*
    // removes the row outright (`ConceptService.purge`).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // Partial on name so an archived concept's display name frees up for reuse
    // (a restore re-checks the live set). Slug stays globally unique — it's the
    // immutable handle the app pins by, so it must never collide on restore.
    uniqueIndex("concepts_org_name_uq").on(t.orgId, t.name).where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex("concepts_org_slug_uq").on(t.orgId, t.slug),
  ],
)

/**
 * The org-wide, flat label vocabulary. A single label can be applied in three
 * scopes — concept-static, concept-default (see `concepts`), and per-record
 * (`record_versions.state.__labels`) — all drawing from this one list. Keyed by `id`
 * (renameable `name`), soft-deleted so any id it ever owned stays resolvable.
 */
export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // Optional free hex color (e.g. "#e11d48"); null renders as a neutral chip.
    color: text("color"),
    // A plain flag for now (rendered with a crown); future features key off it.
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Partial unique so a name can be reused after its label is soft-deleted.
  (t) => [
    uniqueIndex("labels_org_name_uq").on(t.orgId, t.name).where(sql`${t.archivedAt} IS NULL`),
  ],
)

export const fields = pgTable(
  "fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    // `id` is the authoritative key for record version.state / events / relation edges;
    // `name` is a purely decorative, freely-renameable label.
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    formula: text("formula"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    // Per-field ownership marker, mirroring `concepts.managed_by`: the typed
    // integration kind (e.g. "google.gmail") for a field the connector sync owns
    // and keeps read-only, else null for a user-added field. On a managed concept
    // the synced fields carry the kind while user fields stay null — so members
    // can add + edit their OWN fields (e.g. a status) without touching the
    // integration's data. Drives the field-level read-only guard.
    managedBy: text("managed_by"),
    // Optional display glyph (see `concepts.icon`): literal emoji or "lucide:Name".
    icon: text("icon"),
    // Display order within the concept (ascending); ties broken by name. New
    // fields append at the end (max+1). Pure presentation, drag-reorderable in
    // the concept settings editor (see FieldService.reorder).
    position: integer("position").notNull().default(0),
    // Soft delete: a field is never hard-deleted, so any id it ever owned stays
    // resolvable to a name for orphaned `state` keys / historical events.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Partial unique so a name can be reused after its field is soft-deleted.
  (t) => [
    uniqueIndex("fields_concept_name_uq")
      .on(t.conceptId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
)

/**
 * The lineage row for a logical "record" — the stable identity that survives across
 * a concept's versions. Every `record_versions` row belongs to exactly one `records` row
 * (`record_versions.record_id`). For a non-versioned concept (or any legacy row) the
 * mapping is 1:1 (`records.id == record_versions.id`), so "latest published per record" is an
 * identity no-op. For a versioned concept, all of a record's draft→published
 * versions share one `records.id`. References point at `records.id` ("Latest") rather
 * than a specific record version, and whole-record archive lives here (`archived_at`).
 */
export const records = pgTable(
  "records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    // Whole-record (lineage-level) archive — hides every version from head lists.
    // Distinct from per-version `record_versions.archived_at` (which hides one version,
    // rolling the record's "Latest" back to the prior published version).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Who created this lineage (logical fk → bauth_user.id, or a `system:*` actor
    // for a sync). Lives HERE, not on `record_versions`: the lineage is what a person
    // owns — publishing a new version must not change who created the record.
    //
    // Exists for the `actorIs: "creator"` access condition ("records I created"),
    // which needs a column to filter on in SQL. Null for anything created before
    // the backfill, and null never matches — an unattributed record is nobody's.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("records_org_concept_idx").on(t.orgId, t.conceptId)],
)

export const recordVersions = pgTable(
  "record_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    // Lineage this version belongs to. Immutable. For non-versioned/legacy rows
    // it equals `id` (1:1). All versions of one record share this value.
    recordId: uuid("record_id")
      .notNull()
      .references(() => records.id),
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    // `version` (bigint) is the optimistic-concurrency EVENT counter — unrelated
    // to product versioning below. Do not conflate.
    version: bigint("version", { mode: "number" }).notNull().default(0),
    // Product version lifecycle. `version_status`: 'draft' (editable) → 'published'
    // (frozen, immutable, referenceable). `version_seq`: 1,2,3… within the lineage
    // (immutable). Non-versioned/legacy rows are always ('published', seq 1).
    versionStatus: text("version_status").notNull().default("published"),
    versionSeq: integer("version_seq").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("record_versions_org_concept_idx").on(t.orgId, t.conceptId),
    // Supports `state @> {...}` containment filters (QueryService.where).
    index("record_versions_state_gin").using("gin", sql`${t.state} jsonb_path_ops`),
    // Head-only lists: the latest published, non-archived version per record.
    index("record_versions_head_idx")
      .on(t.orgId, t.conceptId, t.recordId, t.versionSeq.desc())
      .where(sql`${t.versionStatus} = 'published' AND ${t.archivedAt} IS NULL`),
    // Lineage operations: list-versions, one-draft check, whole-record archive.
    index("record_versions_record_idx").on(t.recordId),
    // A seq number is never reused within a lineage (allocation is MAX+1 over all
    // rows incl. archived) — this backstops "Latest" from ever being ambiguous.
    uniqueIndex("record_versions_record_seq_uq").on(t.recordId, t.versionSeq),
  ],
)

export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // The relation field def this edge realises (kind=relation). Identity by id,
    // not a type string — so the relation's label is freely renameable.
    fieldId: uuid("field_id")
      .notNull()
      .references(() => fields.id),
    fromId: uuid("from_id")
      .notNull()
      .references(() => recordVersions.id),
    // The referenced lineage ("Latest"): always set. A `to_version_id` of null
    // means the edge resolves to the record's current latest published version;
    // a non-null `to_version_id` pins it to that specific published version.
    toRecordId: uuid("to_record_id")
      .notNull()
      .references(() => records.id),
    toVersionId: uuid("to_version_id").references(() => recordVersions.id),
    // Legacy target column — superseded by (to_record_id, to_version_id). Kept as a
    // shadow for one release to de-risk the migration; dropped once all read paths
    // resolve via the new columns. New edges still populate it (= resolved target).
    toId: uuid("to_id")
      .notNull()
      .references(() => recordVersions.id),
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("relations_from_idx").on(t.orgId, t.fromId, t.fieldId),
    index("relations_to_idx").on(t.orgId, t.toId, t.fieldId),
    index("relations_to_record_idx").on(t.orgId, t.toRecordId, t.fieldId),
    index("relations_to_version_idx").on(t.orgId, t.toVersionId),
  ],
)

/**
 * The `@` mention index — the inbound side of a reference written inside rich text.
 *
 * NOT the source of truth. The mention itself lives in the document
 * (`record_versions.state[fieldId].doc` or `annotations.description.doc`); this table is
 * derived from that doc and rebuilt on every write of it, so that "what mentions
 * this record?" is an indexed lookup rather than a scan of every document in the
 * org. The `record_versions_state_gin` index cannot serve that question: it is
 * `jsonb_path_ops`, whose `@>` is not a recursive search, and a mention sits at
 * arbitrary depth inside `doc.content[…]`.
 *
 * A sibling of `relations` rather than a reuse of it: `RelationService.create`
 * requires a `kind=relation` field and enforces from/to concept matching, and a
 * free-form mention has neither.
 *
 * SOURCE is polymorphic over the two rich-text homes that are server-validated
 * (a dashboard note widget's mentions render and link but are NOT indexed — its
 * body is client-owned and never validated server-side):
 *   `from_version_id` + `from_field_id` — a richtext field on one record version VERSION
 *   `from_annotation_id`                 — a task's description
 * Exactly one branch is set (`mentions_one_source`).
 *
 * TARGET is the node's `kind` + `target_id` verbatim. `target_id` is opaque TEXT,
 * not a typed FK: the six kinds point at four different tables plus a static nav
 * key that has no row at all. `target_record_id` is the one typed column — it mirrors
 * `target_id` when, and only when, `kind = 'record'`, which gives the backlink query
 * a real uuid to index and lets a record purge cascade. Records are the only kind a
 * user can stand on, so they are the only kind needing a backlink query. A record
 * mention whose target has been purged indexes with a NULL `target_record_id`: it
 * stops producing a backlink (correct — the target is gone) while `kind`/`target_id`
 * still record what was meant.
 *
 * LIFECYCLE RULE — this table has FKs to `record_versions`, `fields`, `records` and
 * `annotations`. Any DELETE from those four needs a mentions delete FIRST.
 */
export const mentions = pgTable(
  "mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // ── source: exactly one branch, per the mentions_one_source CHECK ──
    fromVersionId: uuid("from_version_id").references(() => recordVersions.id),
    fromFieldId: uuid("from_field_id").references(() => fields.id),
    fromAnnotationId: uuid("from_annotation_id").references(() => annotations.id),
    // ── target ──
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    // Set iff kind='record'; the indexed, cascadable form of `target_id`.
    targetRecordId: uuid("target_record_id").references(() => records.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE backlink query: inbound record mentions of one lineage.
    index("mentions_target_record_idx").on(t.orgId, t.targetRecordId),
    // Rebuild-on-write: delete this source's rows before re-inserting.
    index("mentions_from_version_idx").on(t.orgId, t.fromVersionId),
    index("mentions_from_annotation_idx").on(t.orgId, t.fromAnnotationId),
    // Non-record backlinks later ("what mentions this dashboard?") without a migration.
    index("mentions_target_idx").on(t.orgId, t.kind, t.targetId),
  ],
)

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor"),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("events_subject_idx").on(t.subjectId, t.id),
    index("events_org_idx").on(t.orgId, t.id),
  ],
)

/**
 * A user-configurable sidebar layout — a "View": an ordered stack of sections,
 * switched via the sidebar pager. `owner_id` null = org-shared (any member sees
 * and may edit it); non-null = personal to that user. The whole layout lives in
 * `body` (a serializable document: sections of ordered entry ids — dashboards
 * and placed global nav records) and is
 * **opaque to the engine** — never read or filtered server-side; the web client
 * resolves it against the live dashboards list. This keeps views off the event
 * store and sets up "define views in code" later.
 */
export const sidebarViews = pgTable(
  "sidebar_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // null = org-shared; non-null = personal (a logical FK into bauth_user.id).
    ownerId: text("owner_id"),
    name: text("name").notNull(),
    // Optional display glyph (see `concepts.icon`): literal emoji or "lucide:Name".
    icon: text("icon"),
    // Order within the pager (ascending); ties broken by created_at.
    position: integer("position").notNull().default(0),
    // Soft visibility toggle — hidden views stay editable in settings but drop
    // out of the pager. Shared on org views (anyone may flip it).
    hidden: boolean("hidden").notNull().default(false),
    body: jsonb("body").notNull().default(sql`'{"sections":[]}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sidebar_views_org_owner_idx").on(t.orgId, t.ownerId)],
)

/**
 * A configurable dashboard — a grid canvas of widgets. Mirrors `sidebar_views`:
 * `owner_id` null = org-shared (any member sees/edits), non-null = personal. The
 * whole layout lives in `body` (a serializable document: widgets + their grid
 * coords/config) and is **opaque to the engine** — never read or filtered
 * server-side; the web client resolves it against the live concept/record version/event
 * collections. This keeps dashboards off the event store.
 *
 * `kind` discriminates two flavours. A `'page'` dashboard (the default, and all
 * legacy rows) is a free-standing canvas with `concept_id` null — it appears in
 * the switcher and may be the org's home. A `'record'` dashboard is a TEMPLATE
 * owned by one concept (`concept_id` set): it renders a single record version at a time
 * (every widget is implicitly about that record) and never shows in the switcher.
 * A concept may own several record dashboards; exactly one is `is_default` (the
 * one used when a reference doesn't name a specific view).
 */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // null = org-shared; non-null = personal (a logical FK into bauth_user.id).
    ownerId: text("owner_id"),
    name: text("name").notNull(),
    // Optional display glyph (see `concepts.icon`): literal emoji or "lucide:Name".
    icon: text("icon"),
    // Order within the dashboard switcher (ascending); ties broken by created_at.
    position: integer("position").notNull().default(0),
    // Soft visibility toggle — hidden dashboards stay editable but drop out of the
    // switcher. Shared on org dashboards (anyone may flip it).
    hidden: boolean("hidden").notNull().default(false),
    // 'page' = free-standing canvas (legacy/default); 'record' = per-concept
    // single-record version template. Drives switcher filtering + the home-seed guard.
    kind: text("kind").notNull().default("page"),
    // The owning concept for a 'record' dashboard (logical FK into concepts.id, no
    // DB FK — matches `concepts.title_field_id`). null for 'page' dashboards.
    conceptId: uuid("concept_id"),
    body: jsonb("body").notNull().default(sql`'{"widgets":[]}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dashboards_org_owner_idx").on(t.orgId, t.ownerId),
    // A concept's record dashboards, in `position` order — the FIRST is the one a
    // bare reference opens (no default flag; reorder to change precedence).
    index("dashboards_concept_idx").on(t.orgId, t.conceptId).where(sql`${t.kind} = 'record'`),
  ],
)

/**
 * A member's record version-detail layout choices — which preset view to render, as a
 * global default plus per-concept overrides (`{ defaultView, byConcept }`,
 * keyed by concept id). The body is opaque to the engine: view keys name
 * client-defined presets. One row per (org, user); owner-only writes.
 */
export const recordViewPrefs = pgTable(
  "record_view_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Logical FK into bauth_user.id (see header comment).
    userId: text("user_id").notNull(),
    body: jsonb("body").notNull().default(sql`'{"defaultView":null,"byConcept":{}}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("record_view_prefs_org_user_uq").on(t.orgId, t.userId)],
)

/**
 * Per-org member deactivation markers (the member analogue of `archived_at`):
 * a row means that user is deactivated in that org — blocked from org access,
 * hidden from user-field pickers, page frozen. Sidecar to BetterAuth's `member`
 * table (never altered) so the two schemas stay independently migratable.
 * Deactivate = insert, reactivate = delete, purge (remove member) deletes too.
 */
export const memberDeactivations = pgTable(
  "member_deactivations",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("member_deactivations_org_user_uq").on(t.orgId, t.userId)],
)

/**
 * Saved node positions for the org's concept graph canvas — one row per org
 * holding a `{ [conceptId]: { x, y } }` document. Pure presentation state
 * (like `sidebar_views`): opaque to the engine, shared org-wide, last write
 * wins, no admin gate.
 */
export const conceptGraphLayouts = pgTable("concept_graph_layouts", {
  orgId: text("org_id").primaryKey(),
  positions: jsonb("positions").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Saved node positions for one record's relationship graph (the record version-page
 * graph tile), keyed by the ROOT record whose graph was arranged. Same contract
 * as the concept canvas: org-shared presentation state, last write wins per
 * node (position keys are record ids, plus `ghost:<relationId>` for dangling refs).
 */
export const recordGraphLayouts = pgTable(
  "record_graph_layouts",
  {
    orgId: text("org_id").notNull(),
    recordId: uuid("record_id").notNull(),
    positions: jsonb("positions").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.recordId] })],
)

/**
 * Files — the binary side of the annotation substrate. Bytes live in the
 * BlobStore under `content_ref`; this row is the org-scoped metadata.
 * `created_by` is a logical fk → bauth_user.id (drives mutate rights at the RPC
 * boundary). Archive hides, purge deletes the row + blob but keeps the event
 * tombstone.
 *
 * **Exactly one owner**, enforced by the `attachments_one_owner` CHECK:
 * - `record_id` — a file on a record. Targets the **record** (like
 *   `annotations.subject_id`), so it survives re-publishes.
 * - `bucket_id` — a file owned by a dashboard Files widget (`scope: "widget"`),
 *   belonging to no record at all. A logical id only: buckets are not an entity,
 *   the uuid is minted client-side and lives in the widget's JSON, so there is
 *   nothing to reference. Widget/dashboard deletion prompts the user to purge or
 *   keep (the body is opaque server-side — no cascade can exist here).
 *
 * `bucket_shared` = may an org-scope Files widget list this row (default yes).
 * Denormalised onto the row, not a bucket table, so the org-scope list filters
 * without a join. It gates *listing* only — a direct download URL is reachable by
 * any member, exactly as for record files.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Nullable since 0035: null ⇒ bucket-owned (see the CHECK below).
    recordId: uuid("record_id").references(() => records.id),
    bucketId: uuid("bucket_id"),
    bucketShared: boolean("bucket_shared").notNull().default(true),
    filename: text("filename").notNull(),
    contentRef: text("content_ref").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // Per-record Files panel (newest first via id).
    index("attachments_record_idx").on(t.orgId, t.recordId, t.id),
    // One widget's bucket, newest first — the record index's counterpart.
    index("attachments_bucket_idx")
      .on(t.orgId, t.bucketId, t.id)
      .where(sql`${t.bucketId} IS NOT NULL`),
    // Concept/org-scope "recent uploads" lists.
    index("attachments_org_idx").on(t.orgId, t.id),
    // Exactly one owner — never both, never neither.
    check("attachments_one_owner", sql`(${t.recordId} IS NULL) <> (${t.bucketId} IS NULL)`),
  ],
)

/**
 * The cross-cutting **annotation layer** — notes and tasks that hang off any
 * Concept Record (or, for tasks, off nothing). Deliberately NOT a concept: a
 * single polymorphic table whose `type` discriminates the variant, with the
 * fixed per-type core in plain columns and an open `custom_fields` bag for
 * user-defined extensions (keyed by `annotation_fields.id`, exactly like
 * `record_versions.state` keys by `fields.id`). Adding a future type (e.g. "comment")
 * is one `type` literal + maybe a nullable column — no table fan-out.
 *
 * Unlike record versions, annotations are NOT event-sourced projections: the row is
 * the source of truth (CRUD), and each mutation still appends an `events` row
 * purely for the activity feed / live-sync (the `LabelService`/`FieldService`
 * pattern). Their own event stream uses subject_kind "note"/"task" with
 * subject_id = this row's id, so they never enter the record version fold.
 *
 * `subject_id` targets the **record** (`records.id`, "the thing"), NOT a
 * specific version — so a note/task survives re-publishes, exactly like how
 * `relations.to_record_id` references the lineage. NULL = an org-level annotation
 * (a standalone task hung off no record). `status_id` (→ task_statuses) and
 * `assignee` (→ bauth_user.id) are likewise LOGICAL fks (no Drizzle reference):
 * they tolerate null and survive status archive (orphan-tolerant, matching the
 * archive-vs-delete convention). Existence is checked at the service / RPC
 * boundary, not by the DB.
 */
export const annotations = pgTable(
  "annotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Variant discriminator: "note" | "task" today; append-only.
    type: text("type").notNull(),
    // The annotated record (records.id). NULL = org-level annotation.
    subjectId: uuid("subject_id"),
    // Forward-compat for hanging off other subject kinds later; "record" whenever
    // subject_id is non-null, else null.
    subjectKind: text("subject_kind"),

    // ── note core ── (non-null when type='note')
    body: text("body"),

    // ── task core ── (non-null when type='task')
    title: text("title"),
    // Logical fk → task_statuses.id; defaulted to the org's `is_default` status
    // at create time. Kept as an id (not a name) so statuses stay renameable.
    statusId: uuid("status_id"),
    // Logical fk → bauth_user.id, validated against org membership at the RPC
    // boundary (like record version `user`-kind fields).
    assignee: text("assignee"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // Rich-text description: a `{ doc, text }` envelope (ProseMirror JSON +
    // server-derived plain text), same shape as record version `richtext` fields.
    description: jsonb("description"),
    // Logical fk → task_priorities.id; null = no priority (orphan-tolerant).
    priorityId: uuid("priority_id"),
    // This task's own label ids (labels.id array) — the org label vocabulary,
    // mirroring the record version `__labels` pattern but as a real column.
    labelIds: jsonb("label_ids").notNull().default(sql`'[]'::jsonb`),
    // Hidden from "open" lists until this passes (read-time check, no sweeper).
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    // Blocked marker: when set the task renders blocked; reason + an optional
    // pointer to the blocking task (logical fk → annotations.id, no auto-unblock).
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    blockedByTaskId: uuid("blocked_by_task_id"),
    // Set when the status enters the `done` category, cleared when it leaves.
    // `cancelled` never sets it — closed ≠ completed.
    completedAt: timestamp("completed_at", { withTimezone: true }),

    // Author/creator (= event actor = bauth_user.id); drives edit/purge rights.
    createdBy: text("created_by"),
    // User-defined custom fields, keyed by annotation_fields.id.
    customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

    // Optimistic-concurrency counter (a plain bump per write — NOT an event
    // count, since annotations aren't folded). Mirrors record version update ergonomics.
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // Per-record panel: a subject's notes/tasks, newest first, filterable by type.
    index("annotations_subject_idx").on(t.orgId, t.subjectId, t.type, t.id),
    // Global task queries ("assigned to me", by status). Partial → task-only, small.
    index("annotations_assignee_idx")
      .on(t.orgId, t.assignee, t.statusId, t.dueAt)
      .where(sql`${t.type} = 'task' AND ${t.archivedAt} IS NULL`),
    // Global "due this week" / org task board, ordered by due date.
    index("annotations_due_idx")
      .on(t.orgId, t.dueAt)
      .where(sql`${t.type} = 'task' AND ${t.archivedAt} IS NULL`),
  ],
)

/**
 * Per-org, configurable task statuses (Open / In progress / Done … — editable
 * names, colors and order). `category` ("todo" | "active" | "done") carries the
 * *semantics* — completion and grouping key off it, never off the renameable
 * `name` (per the no-name-special-casing rule). `is_default` marks the status a
 * new task gets. Seeded for every org by `seedKahuna`. Soft-deleted so an
 * archived status's id stays resolvable for historical tasks.
 */
export const taskStatuses = pgTable(
  "task_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // Optional free hex color (e.g. "#16a34a"); null → neutral chip.
    color: text("color"),
    // Semantic bucket driving completion + grouping: "todo" | "active" | "done".
    category: text("category").notNull(),
    // The status applied to a newly created task (exactly one live per org).
    isDefault: boolean("is_default").notNull().default(false),
    // Display order within the picker / board (ascending).
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Partial unique so a name frees up after its status is archived.
  (t) => [
    uniqueIndex("task_statuses_org_name_uq")
      .on(t.orgId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
)

/**
 * Per-org, configurable task priorities (Urgent / High / … — editable names,
 * colors and order). The `task_statuses` shape minus category/is_default: a
 * priority carries no semantics beyond its position (lower = more urgent), and
 * a new task starts with NO priority (`annotations.priority_id` null). Seeded
 * for every org by `seedKahuna`. Soft-deleted like statuses.
 */
export const taskPriorities = pgTable(
  "task_priorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // Optional free hex color (e.g. "#dc2626"); null → neutral chip.
    color: text("color"),
    // Display order within the picker (ascending; lower = more urgent).
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Partial unique so a name frees up after its priority is archived.
  (t) => [
    uniqueIndex("task_priorities_org_name_uq")
      .on(t.orgId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
)

/**
 * Custom-field DEFINITIONS for the annotation layer — the same shape as `fields`
 * but scoped by `annotation_type` ("note" | "task") instead of a concept, so
 * notes/tasks gain user-defined fields WITHOUT being modeled as concepts. Values
 * live in `annotations.custom_fields` keyed by this row's id (id-keyed, so a
 * rename needs no backfill). Restricted to scalar `kind`s (no relation/computed/
 * file). Soft-deleted like `fields`.
 */
export const annotationFields = pgTable(
  "annotation_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Which annotation variant these fields apply to: "note" | "task".
    annotationType: text("annotation_type").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    icon: text("icon"),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Partial unique so a name frees up after its def is archived.
  (t) => [
    uniqueIndex("annotation_fields_type_name_uq")
      .on(t.orgId, t.annotationType, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
)

/**
 * **Automations** — "when X, if Y, then Z", one row per rule.
 *
 * The whole model is three slots, each drawn from a closed vocabulary:
 * `trigger` (which event, or a schedule), `conditions` (the SAME
 * `SidebarCondition[]` shape every widget/filter bar uses), and `actions` (an
 * ordered list of thin calls onto existing services). All three are jsonb and
 * validated by the RPC contract — an APPEND-ONLY union, exactly like dashboard
 * widget bodies: add new trigger/action kinds freely, never reshape an existing
 * one, because old rows must keep parsing.
 *
 * A trigger is not new machinery — it is a filter over the `events` stream this
 * schema already writes (and already announces via `pg_notify`). Concepts and
 * fields inside `trigger`/`conditions`/`actions` are referenced by **id**, never
 * by name, so renaming a concept can never break a rule.
 *
 * Soft-deleted (`archived_at`) rather than deleted: a run history pointing at a
 * vanished automation explains nothing.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // Disabled automations are skipped by the runner but keep their run history.
    enabled: boolean("enabled").notNull().default(false),
    // { kind, conceptId?, fieldId?, to?, statusId?, band?, cron?, hour?, weekday?, day? }
    trigger: jsonb("trigger").notNull(),
    // SidebarCondition[] — the shared filter shape (see src/lib/conditions.ts).
    conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
    // How the condition set combines: "all" | "any".
    match: text("match").notNull().default("all"),
    // Action[] — ordered, run sequentially; first failure stops the run.
    actions: jsonb("actions").notNull().default(sql`'[]'::jsonb`),
    // Schedule triggers only: when this is next due. Claimed atomically by the
    // tick (UPDATE … WHERE next_run_at <= now() RETURNING), so two server
    // record versions can never both take one. NULL for event triggers.
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    // Non-null ⇒ the automation paused ITSELF (rate cap tripped); shown in the
    // list so a runaway is visible rather than silent.
    pausedReason: text("paused_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // The runner's hot path: enabled automations for one org.
    index("automations_org_idx").on(t.orgId, t.enabled).where(sql`${t.archivedAt} IS NULL`),
    // The schedule tick's claim scan, across all orgs.
    index("automations_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.nextRunAt} IS NOT NULL AND ${t.archivedAt} IS NULL`),
  ],
)

/**
 * One attempt of one automation — and NOT merely a log. This table is
 * load-bearing three times over:
 *
 *  1. **The idempotency guard.** The runner inserts its row *before* acting,
 *     under `unique (automation_id, event_id)`. A duplicate delivery (two server
 *     record versions, an SSE reconnect replay) loses the insert race and skips. So
 *     correctness does not depend on there being exactly one process — which
 *     matters, because "exactly one process" is a deployment property.
 *  2. **The rate-cap window.** Runs per minute are counted off `started_at`.
 *  3. **The answer to "why didn't it fire?"** — a non-matching event records
 *     `status: 'skipped'` rather than vanishing.
 *
 * `event_id` is NULL for schedule-triggered runs (there is no event); those rows
 * carry `subject_id` instead. Deleting the parent automation cascades.
 */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    // The triggering event (`events.id`); NULL for a scheduled run.
    eventId: bigint("event_id", { mode: "number" }),
    // The record the run acted on (`record_versions.id`); NULL when there is none.
    subjectId: uuid("subject_id"),
    // "ok" | "skipped" | "failed".
    status: text("status").notNull(),
    // Per-action outcome, or the failure (which step, and why).
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // THE guard: one run per (automation, event). Partial, because scheduled runs
    // have a NULL event_id and NULLs never conflict in a unique index anyway —
    // being explicit documents that only event runs are deduped this way.
    uniqueIndex("automation_runs_event_uq")
      .on(t.automationId, t.eventId)
      .where(sql`${t.eventId} IS NOT NULL`),
    // The run-history panel (newest first) + the rate-cap window scan.
    index("automation_runs_recent_idx").on(t.automationId, t.startedAt),
  ],
)

/**
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 *
 * One mechanism for every "who may do what" question, replacing three unrelated
 * ones (concepts.visibility, fields.visibility, dashboards.owner_id as
 * personal/shared). `fields.visibility` is gone now — see `AccessResourceType`'s
 * doc in `engine/domain/access.ts` for why field access has no per-role override
 * left at all. See that file for the decision procedure and
 * `engine/domain/visibility.ts` for the concept-visibility placement constraints
 * that still hold.
 *
 * TWO LAYERS for a concept. The DEFAULT lives on the resource itself
 * (`concepts.visibility`) and answers "who sees this normally?"; `access_rules`
 * are the EXCEPTIONS layered over it. Keeping the default a column is what lets a
 * list query filter in SQL without joining rules for the common case.
 */

/**
 * A named, reusable bag of rules. `Admin`/`Member` ship managed and are ordinary rows
 * — editable, not hardcoded tiers — plus one managed role in the `automation`
 * category that every automation starts with.
 *
 * An actor may hold ANY NUMBER of roles, and — since the access model became a
 * CASCADE of layers rather than a flat union — their `access_role_actors.position`
 * on each one decides which wins when two roles disagree. This table's own
 * `position` below is unrelated: display order on the Roles page, nothing more.
 */
export const accessRoles = pgTable(
  "access_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Stable system key (`admin`, `member`, `automation_full`), mirroring
    // `concepts.slug`. Its ONE job is seed idempotency — `ensureBuiltins` uses it to
    // add a newly-shipped managed role without touching the others. It is not an
    // authorization concept: `name` is freely renameable, deletion is refused by
    // `managed`, and where new actors land is `auto_assign`.
    key: text("key"),
    name: text("name").notNull(),
    description: text("description"),
    // Seeded by us, so DELETE is refused — the seed would re-create it on the next
    // provision and quietly restore access someone removed on purpose. Its rules,
    // name and every flag below stay editable, and `active` is the reversible way to
    // turn one off for good.
    managed: boolean("managed").notNull().default(false),
    // WHICH CATEGORY, and who may hold it. A `user` role belongs to people; an
    // `automation` role belongs to automation actors (`system:automation:*`). The
    // engine refuses a mismatch on assign, so the split is real and not cosmetic:
    // an automation's access can be reshaped without any of it landing on a person.
    kind: text("kind").notNull().default("user"),
    // New actors OF THIS KIND receive this role. Settable on any number of roles —
    // a new member gets every auto-assign `user` role, a new automation every
    // auto-assign `automation` role. This replaces the hardcoded membership-role →
    // preset mapping that used to live in `server/membership.ts`.
    autoAssign: boolean("auto_assign").notNull().default(false),
    // OFF, reversibly. An inactive role's rules are excluded from every resolved
    // policy (`PolicyService.loadRules`) and it is not auto-assigned — but its
    // ASSIGNMENTS are kept, so reactivating restores exactly what was there. This is
    // what a managed role has instead of delete.
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    // INHERITANCE. A role may be BASED ON another; resolving it walks the chain
    // (via `access_role_actors.position`, then chain depth) so a role's own value
    // always beats what it inherits. `ON DELETE SET NULL`, not cascade — deleting a
    // parent must not delete every role that named it, only sever the link (the
    // child's own rules are unaffected either way). Nullable self-reference, so
    // `AnyPgColumn` types the lazy callback (drizzle needs it — `accessRoles` isn't
    // defined yet at the point this column's own definition runs).
    basedOn: uuid("based_on").references((): AnyPgColumn => accessRoles.id, {
      onDelete: "set null",
    }),
    // LAYER 1. Set = this role is one PERSON's overrides, not a reusable role: it
    // holds the actor id (a user id) it belongs to, created lazily the first time an
    // admin sets an override for that person and resolved at a fixed precedence
    // ABOVE every ordinary role (see `PolicyService.loadRules`) — "this person,
    // specifically" beats any role they hold. Hidden from the Roles list, assignable
    // only to its own actor, never a `based_on` target. Unique per (org, actor): one
    // sheet of overrides per person, not a role you could accidentally duplicate.
    personalFor: text("personal_for"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("access_roles_key_uq").on(t.orgId, t.key).where(sql`${t.key} IS NOT NULL`),
    index("access_roles_org_idx").on(t.orgId, t.position),
    uniqueIndex("access_roles_personal_for_uq")
      .on(t.orgId, t.personalFor)
      .where(sql`${t.personalFor} IS NOT NULL`),
  ],
)

/**
 * Who holds a role. `actor_id` is a user id OR a non-person actor string —
 * `server/automations.ts` already mints `system:automation:<uuid>` via `actorFor`,
 * and connectors key the same way. So people and machines are assigned through one
 * table, with no second code path to keep in sync.
 *
 * A member may hold several roles; their access CASCADES rather than merely
 * unions — `position` orders THIS actor's roles (0 = highest precedence; ties keep
 * the flat "any deny beats any allow" semantics), so two roles disagreeing is no
 * longer a contradiction, it is a question with an answer. Ordering someone's roles
 * changes nothing for anyone else — it lives here, per (role, actor), not on
 * `access_roles` itself. Default 0 for every row today: until something sets a
 * different value, every held role ties, which is exactly the old flat union.
 */
export const accessRoleActors = pgTable(
  "access_role_actors",
  {
    orgId: text("org_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => accessRoles.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    position: integer("position").notNull().default(0),
    // Who assigned it, for the audit trail (the event log carries this too).
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.actorId] }),
    // THE hot path: every rule applying to one actor, resolved per request.
    index("access_role_actors_actor_idx").on(t.orgId, t.actorId),
  ],
)

/**
 * One grant (or refusal), attached to a role.
 *
 * DENY WINS, absolutely: no specificity ladder, no "narrower beats broader". A
 * precedence table is what makes an access model unreadable to the person editing
 * it — see `decide()`.
 *
 * Every rule belongs to a ROLE. The `actor_id` column (a per-person share) was kept
 * unread through a rollback window and is dropped in 0022 — rules arriving only via
 * roles is exactly what makes a fixed (role, chain) precedence a complete ordering.
 */
export const accessRules = pgTable(
  "access_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // EVERY rule belongs to a role. `actor_id` (a per-person share) was dropped in
    // 0022 along with its partial index and the one-subject CHECK — rules arriving
    // only via roles is what makes a fixed (role, chain) precedence a total order.
    roleId: uuid("role_id").references(() => accessRoles.id, { onDelete: "cascade" }),
    // 'allow' | 'deny'.
    effect: text("effect").notNull().default("allow"),
    // Action names, exhaustively — there is no wildcard. See ACCESS_ACTIONS.
    actions: text("actions").array().notNull(),
    // 'org' | 'concept' | 'record' | 'field' | 'dashboard' | 'view' | 'automation'
    // | 'bucket' | 'task' | 'note' | 'member'.
    resourceType: text("resource_type").notNull(),
    // NULL = every resource of this type. For a 'record' rule this is an
    // **records.id** (the lineage), NEVER an record_versions.id: a versioned concept has N
    // version rows per record, and a rule naming one record must survive publishing
    // a new version.
    resourceId: uuid("resource_id"),
    // Scopes a 'record' or 'field' rule to one concept without naming a row — how
    // "may act on any Deal" is expressed without a rule per deal.
    conceptId: uuid("concept_id"),
    // AccessCondition | null (null = unconditional). Every variant MUST compile to
    // a SQL predicate, because record reads are filtered inside the query — a
    // post-fetch filter breaks counts and truncation. See engine/domain/access.ts.
    condition: jsonb("condition"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The hot path: every rule applying to one actor, resolved per request via
    // their roles.
    index("access_rules_role_idx").on(t.orgId, t.roleId).where(sql`${t.roleId} IS NOT NULL`),
    // Rules naming one resource — what a role's "Other" rule list and the
    // permissions grid read.
    index("access_rules_resource_idx").on(t.orgId, t.resourceType, t.resourceId),
  ],
)

/**
 * Cache generation for an org's policy, bumped on EVERY access write.
 *
 * `PolicyService` memoizes a resolved rule set per (org, actor) and keys it on this
 * number, so a rule change is picked up by the next request without a TTL or a
 * process-wide flush. A missing row reads as version 0.
 *
 * Its own table rather than a column on the org: orgs live in BetterAuth
 * (`bauth_organization`) and the engine must never read auth tables.
 */
export const accessPolicyVersions = pgTable("access_policy_versions", {
  orgId: text("org_id").primaryKey(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
