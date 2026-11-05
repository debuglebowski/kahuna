ALTER TABLE "concepts" ADD COLUMN "approval_policy" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "record_versions" ADD COLUMN "release" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "record_versions_record_name_uq" ON "record_versions" USING btree ("record_id",("release"->>'name')) WHERE "record_versions"."release"->>'name' IS NOT NULL;