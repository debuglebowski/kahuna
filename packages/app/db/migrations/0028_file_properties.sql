-- File properties: a `kind: "file"` field holds its files as ordinary record
-- attachments (same blob store, same rights, same soft delete), linked by
-- `attachments.field_id` and ordered by `position`. `staged_until` marks an
-- upload made before its record exists (owner-less until `createRecord` claims
-- it; swept after expiry). See schema.ts `attachments`.
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_owner";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "field_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "staged_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_field_idx" ON "attachments" USING btree ("org_id","record_id","field_id","position") WHERE "attachments"."field_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_staged_idx" ON "attachments" USING btree ("staged_until") WHERE "attachments"."staged_until" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_field_needs_record" CHECK ("attachments"."field_id" IS NULL OR "attachments"."record_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_owner" CHECK (CASE WHEN "attachments"."staged_until" IS NULL THEN ("attachments"."record_id" IS NULL) <> ("attachments"."bucket_id" IS NULL) ELSE "attachments"."record_id" IS NULL AND "attachments"."bucket_id" IS NULL END);--> statement-breakpoint

-- Existing single-file values. Before this migration a file field had no value
-- path at all (the engine refused every write to one), so nothing should match
-- below; the two statements exist so a database that got a value in some other
-- way (a hand edit, an import) converges instead of keeping a stray key.
--
-- 1. A state value that names an attachment ON THE SAME RECORD — as an id string,
--    an `{ id }` object, or a list of either — becomes that property's value: the
--    attachment is linked to the field, in list order. The newest version's value
--    wins when versions disagree. A value naming no such attachment links nothing
--    (there are no bytes to point at).
UPDATE "attachments" a
SET "field_id" = v."field_id", "position" = v."pos"
FROM (
  SELECT DISTINCT ON (x."att_id") rv."record_id", f."id" AS "field_id", x."att_id", x."pos"
  FROM "record_versions" rv
  JOIN "fields" f
    ON f."org_id" = rv."org_id" AND f."concept_id" = rv."concept_id" AND f."kind" = 'file'
  CROSS JOIN LATERAL (
    SELECT
      CASE jsonb_typeof(e."val")
        WHEN 'string' THEN e."val" #>> '{}'
        WHEN 'object' THEN e."val"->>'id'
      END AS "att_id",
      (e."ord" - 1)::int AS "pos"
    FROM jsonb_array_elements(
      CASE jsonb_typeof(rv."state"->(f."id"::text))
        WHEN 'array' THEN rv."state"->(f."id"::text)
        ELSE jsonb_build_array(rv."state"->(f."id"::text))
      END
    ) WITH ORDINALITY AS e("val", "ord")
  ) x
  WHERE rv."state" ? (f."id"::text) AND x."att_id" IS NOT NULL
  ORDER BY x."att_id", rv."version_seq" DESC
) v
WHERE a."record_id" = v."record_id" AND a."id"::text = v."att_id" AND a."field_id" IS NULL;--> statement-breakpoint

-- 2. A file property's value is derived from `attachments` at read time, never
--    stored in `state` — drop any stored key so nothing stale can shadow it.
UPDATE "record_versions" rv
SET "state" = rv."state" - k."keys"
FROM (
  SELECT rv2."id", array_agg(f."id"::text) AS "keys"
  FROM "record_versions" rv2
  JOIN "fields" f
    ON f."org_id" = rv2."org_id" AND f."concept_id" = rv2."concept_id" AND f."kind" = 'file'
  WHERE rv2."state" ? (f."id"::text)
  GROUP BY rv2."id"
) k
WHERE rv."id" = k."id";
