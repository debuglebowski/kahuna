-- Add the stable `slug` system key. Existing rows are backfilled from the
-- current name (slugified, de-duplicated per org with a numeric suffix) so the
-- NOT NULL + unique constraint can be enforced. Mirrors ConceptService.slugify.
ALTER TABLE "concepts" ADD COLUMN "slug" text;--> statement-breakpoint
WITH s AS (
  SELECT
    id,
    coalesce(
      nullif(trim(both '_' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '_', 'g'))), ''),
      'concept'
    ) AS base,
    row_number() OVER (
      PARTITION BY org_id, coalesce(
        nullif(trim(both '_' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '_', 'g'))), ''),
        'concept'
      )
      ORDER BY created_at, id
    ) AS rn
  FROM "concepts"
)
UPDATE "concepts" c
SET slug = CASE WHEN s.rn = 1 THEN s.base ELSE s.base || '_' || s.rn END
FROM s
WHERE s.id = c.id;--> statement-breakpoint
ALTER TABLE "concepts" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_slug_uq" ON "concepts" USING btree ("org_id","slug");
