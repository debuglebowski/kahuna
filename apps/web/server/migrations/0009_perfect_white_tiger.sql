ALTER TABLE "google_connection" ADD COLUMN "gmail_concept_id" text;--> statement-breakpoint
ALTER TABLE "google_connection" ADD COLUMN "gmail_field_map" jsonb DEFAULT '{}'::jsonb NOT NULL;