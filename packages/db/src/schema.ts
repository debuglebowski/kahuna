import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
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
 * `instances.state` / `relations` are projections derived from it.
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
    // to tint the concept wherever instances are visualised. Null = neutral.
    color: text("color"),
    // Connector-owned "managed concept" marker: a typed integration kind (e.g.
    // "linear", "google.gmail", "google.calendar") when this concept's schema +
    // instances are owned by an integration sync, else null for a normal user
    // concept. Drives read-only guards (at the RPC boundary) and an opinionated
    // instance detail view. Keyed by this kind, never by the concept name.
    managedBy: text("managed_by"),
    // Label-id arrays drawn from the org-wide `labels` vocabulary. `static` =
    // inherited by every instance (read-time, never written per item); `default`
    // = snapshotted onto each new instance's `state.__labels` at creation time.
    // Stored as ids (not names) so a label rename needs no backfill.
    staticLabelIds: jsonb("static_label_ids").notNull().default(sql`'[]'::jsonb`),
    defaultLabelIds: jsonb("default_label_ids").notNull().default(sql`'[]'::jsonb`),
    // Opt-in "Versioning": when true, this concept's items hold multiple draft→
    // published versions (each a first-class `instances` row sharing an `items`
    // lineage), and references may pin a specific published version. When false
    // (default) the concept behaves exactly as the plain 1-instance-per-item model.
    versioningEnabled: boolean("versioning_enabled").notNull().default(false),
    // Org-wide default detail layout for this concept's instances: a 12-col grid
    // of tiles (`{ tiles: [...] }`), the same shape as the view-prefs custom
    // layouts. Null = render the built-in default preset. Set in concept
    // settings → Layout; every instance of the concept renders it (there is no
    // per-user layout switch).
    instanceView: jsonb("instance_view"),
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
 * scopes — concept-static, concept-default (see `concepts`), and per-item
 * (`instances.state.__labels`) — all drawing from this one list. Keyed by `id`
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
    // `id` is the authoritative key for instance.state / events / relation edges;
    // `name` is a purely decorative, freely-renameable label.
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    formula: text("formula"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
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
 * The lineage row for a logical "item" — the stable identity that survives across
 * a concept's versions. Every `instances` row belongs to exactly one `items` row
 * (`instances.item_id`). For a non-versioned concept (or any legacy row) the
 * mapping is 1:1 (`items.id == instances.id`), so "latest published per item" is an
 * identity no-op. For a versioned concept, all of an item's draft→published
 * versions share one `items.id`. References point at `items.id` ("Latest") rather
 * than a specific instance, and whole-item archive lives here (`archived_at`).
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    // Whole-item (lineage-level) archive — hides every version from head lists.
    // Distinct from per-version `instances.archived_at` (which hides one version,
    // rolling the item's "Latest" back to the prior published version).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("items_org_concept_idx").on(t.orgId, t.conceptId)],
)

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    // Lineage this version belongs to. Immutable. For non-versioned/legacy rows
    // it equals `id` (1:1). All versions of one item share this value.
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
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
    index("instances_org_concept_idx").on(t.orgId, t.conceptId),
    // Supports `state @> {...}` containment filters (QueryService.where).
    index("instances_state_gin").using("gin", sql`${t.state} jsonb_path_ops`),
    // Head-only lists: the latest published, non-archived version per item.
    index("instances_head_idx")
      .on(t.orgId, t.conceptId, t.itemId, t.versionSeq.desc())
      .where(sql`${t.versionStatus} = 'published' AND ${t.archivedAt} IS NULL`),
    // Lineage operations: list-versions, one-draft check, whole-item archive.
    index("instances_item_idx").on(t.itemId),
    // A seq number is never reused within a lineage (allocation is MAX+1 over all
    // rows incl. archived) — this backstops "Latest" from ever being ambiguous.
    uniqueIndex("instances_item_seq_uq").on(t.itemId, t.versionSeq),
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
      .references(() => instances.id),
    // The referenced lineage ("Latest"): always set. A `to_version_id` of null
    // means the edge resolves to the item's current latest published version;
    // a non-null `to_version_id` pins it to that specific published version.
    toItemId: uuid("to_item_id")
      .notNull()
      .references(() => items.id),
    toVersionId: uuid("to_version_id").references(() => instances.id),
    // Legacy target column — superseded by (to_item_id, to_version_id). Kept as a
    // shadow for one release to de-risk the migration; dropped once all read paths
    // resolve via the new columns. New edges still populate it (= resolved target).
    toId: uuid("to_id")
      .notNull()
      .references(() => instances.id),
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("relations_from_idx").on(t.orgId, t.fromId, t.fieldId),
    index("relations_to_idx").on(t.orgId, t.toId, t.fieldId),
    index("relations_to_item_idx").on(t.orgId, t.toItemId, t.fieldId),
    index("relations_to_version_idx").on(t.orgId, t.toVersionId),
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
 * and placed global nav items) and is
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
 * server-side; the web client resolves it against the live concept/instance/event
 * collections. This keeps dashboards off the event store.
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
    body: jsonb("body").notNull().default(sql`'{"widgets":[]}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboards_org_owner_idx").on(t.orgId, t.ownerId)],
)

/**
 * A member's instance-detail layout choices — which preset view to render, as a
 * global default plus per-concept overrides (`{ defaultView, byConcept }`,
 * keyed by concept id). The body is opaque to the engine: view keys name
 * client-defined presets. One row per (org, user); owner-only writes.
 */
export const instanceViewPrefs = pgTable(
  "instance_view_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Logical FK into bauth_user.id (see header comment).
    userId: text("user_id").notNull(),
    body: jsonb("body").notNull().default(sql`'{"defaultView":null,"byConcept":{}}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("instance_view_prefs_org_user_uq").on(t.orgId, t.userId)],
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
 * Saved node positions for one item's relationship graph (the instance-page
 * graph tile), keyed by the ROOT item whose graph was arranged. Same contract
 * as the concept canvas: org-shared presentation state, last write wins per
 * node (position keys are item ids, plus `ghost:<relationId>` for dangling refs).
 */
export const instanceGraphLayouts = pgTable(
  "instance_graph_layouts",
  {
    orgId: text("org_id").notNull(),
    itemId: uuid("item_id").notNull(),
    positions: jsonb("positions").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.itemId] })],
)

/**
 * Files on items — the binary side of the annotation substrate. Bytes live in
 * the BlobStore under `content_ref`; this row is the org-scoped metadata.
 * `item_id` targets the **item lineage** (like `annotations.subject_id`), so a
 * file survives re-publishes. `created_by` is a logical fk → bauth_user.id
 * (drives mutate rights at the RPC boundary). Archive hides, purge deletes the
 * row + blob but keeps the event tombstone.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    filename: text("filename").notNull(),
    contentRef: text("content_ref").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // Per-item Files panel (newest first via id).
    index("attachments_item_idx").on(t.orgId, t.itemId, t.id),
    // Concept/org-scope "recent uploads" lists.
    index("attachments_org_idx").on(t.orgId, t.id),
  ],
)

/**
 * The cross-cutting **annotation layer** — notes and tasks that hang off any
 * Concept Item (or, for tasks, off nothing). Deliberately NOT a concept: a
 * single polymorphic table whose `type` discriminates the variant, with the
 * fixed per-type core in plain columns and an open `custom_fields` bag for
 * user-defined extensions (keyed by `annotation_fields.id`, exactly like
 * `instances.state` keys by `fields.id`). Adding a future type (e.g. "comment")
 * is one `type` literal + maybe a nullable column — no table fan-out.
 *
 * Unlike instances, annotations are NOT event-sourced projections: the row is
 * the source of truth (CRUD), and each mutation still appends an `events` row
 * purely for the activity feed / live-sync (the `LabelService`/`FieldService`
 * pattern). Their own event stream uses subject_kind "note"/"task" with
 * subject_id = this row's id, so they never enter the instance fold.
 *
 * `subject_id` targets the **item lineage** (`items.id`, "the thing"), NOT a
 * specific version — so a note/task survives re-publishes, exactly like how
 * `relations.to_item_id` references the lineage. NULL = an org-level annotation
 * (a standalone task hung off no item). `status_id` (→ task_statuses) and
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
    // The annotated item lineage (items.id). NULL = org-level annotation.
    subjectId: uuid("subject_id"),
    // Forward-compat for hanging off other subject kinds later; "item" whenever
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
    // boundary (like instance `user`-kind fields).
    assignee: text("assignee"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // Rich-text description: a `{ doc, text }` envelope (ProseMirror JSON +
    // server-derived plain text), same shape as instance `richtext` fields.
    description: jsonb("description"),
    // Logical fk → task_priorities.id; null = no priority (orphan-tolerant).
    priorityId: uuid("priority_id"),
    // This task's own label ids (labels.id array) — the org label vocabulary,
    // mirroring the instance `__labels` pattern but as a real column.
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
    // count, since annotations aren't folded). Mirrors instance update ergonomics.
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // Per-item panel: a subject's notes/tasks, newest first, filterable by type.
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
 * new task gets. Seeded for every org by `seedKingsmaker`. Soft-deleted so an
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
 * for every org by `seedKingsmaker`. Soft-deleted like statuses.
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
