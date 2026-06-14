ALTER TABLE "google_connection" ADD COLUMN "concept_id" text;--> statement-breakpoint
ALTER TABLE "google_connection" ADD COLUMN "field_map" jsonb DEFAULT '{}'::jsonb NOT NULL;