ALTER TABLE "fields" ADD COLUMN "managed_by" text;--> statement-breakpoint
-- Backfill: every existing field on a managed concept is, by definition,
-- integration-owned at migration time — mark it with the concept's kind so it
-- stays read-only. Fields added afterwards (by users) keep managed_by NULL.
UPDATE "fields" f SET "managed_by" = c."managed_by"
  FROM "concepts" c
  WHERE f."concept_id" = c."id" AND c."managed_by" IS NOT NULL;