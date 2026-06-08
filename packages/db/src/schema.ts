import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
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
    description: text("description"),
    // Optional display glyph: a literal emoji (e.g. "🏢") or a curated lucide
    // icon name prefixed "lucide:" (e.g. "lucide:Building2"); null renders none.
    icon: text("icon"),
    // Label-id arrays drawn from the org-wide `labels` vocabulary. `static` =
    // inherited by every instance (read-time, never written per item); `default`
    // = snapshotted onto each new instance's `state.__labels` at creation time.
    // Stored as ids (not names) so a label rename needs no backfill.
    staticLabelIds: jsonb("static_label_ids").notNull().default(sql`'[]'::jsonb`),
    defaultLabelIds: jsonb("default_label_ids").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("concepts_org_name_uq").on(t.orgId, t.name),
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  // Partial unique so a name can be reused after its label is soft-deleted.
  (t) => [uniqueIndex("labels_org_name_uq").on(t.orgId, t.name).where(sql`${t.deletedAt} IS NULL`)],
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
    // Soft delete: a field is never hard-deleted, so any id it ever owned stays
    // resolvable to a name for orphaned `state` keys / historical events.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  // Partial unique so a name can be reused after its field is soft-deleted.
  (t) => [
    uniqueIndex("fields_concept_name_uq")
      .on(t.conceptId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("instances_org_concept_idx").on(t.orgId, t.conceptId),
    // Supports `state @> {...}` containment filters (QueryService.where).
    index("instances_state_gin").using("gin", sql`${t.state} jsonb_path_ops`),
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
    toId: uuid("to_id")
      .notNull()
      .references(() => instances.id),
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("relations_from_idx").on(t.orgId, t.fromId, t.fieldId),
    index("relations_to_idx").on(t.orgId, t.toId, t.fieldId),
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

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  instanceId: uuid("instance_id")
    .notNull()
    .references(() => instances.id),
  filename: text("filename").notNull(),
  contentRef: text("content_ref").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
