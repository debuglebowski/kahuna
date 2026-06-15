ALTER TABLE "concepts" ADD COLUMN "title_field_id" uuid;--> statement-breakpoint
-- Backfill the display-label field so a concept's "title" is an explicit field
-- rather than a runtime guess. NON-managed concepts: the first text field, else
-- the first scalar (relations/files can't be a title), by field order. MANAGED
-- concepts are left null here — their title is set precisely from the connector's
-- field map by a one-off backfill (the title key differs per integration).
UPDATE "concepts" c SET "title_field_id" = (
  SELECT f.id FROM "fields" f
  WHERE f.concept_id = c.id AND f.archived_at IS NULL
    AND f.kind NOT IN ('relation', 'file')
  ORDER BY (f.kind = 'text') DESC, f.position ASC, f.name ASC
  LIMIT 1
)
WHERE c.managed_by IS NULL AND c.title_field_id IS NULL;