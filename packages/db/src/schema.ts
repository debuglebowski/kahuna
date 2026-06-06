import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
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
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("concepts_org_name_uq").on(t.orgId, t.name)],
)

export const fields = pgTable(
  "fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    formula: text("formula"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex("fields_concept_name_uq").on(t.conceptId, t.name)],
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
  (t) => [index("instances_org_concept_idx").on(t.orgId, t.conceptId)],
)

export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    relationType: text("relation_type").notNull(),
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
    index("relations_from_idx").on(t.orgId, t.fromId, t.relationType),
    index("relations_to_idx").on(t.orgId, t.toId, t.relationType),
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
