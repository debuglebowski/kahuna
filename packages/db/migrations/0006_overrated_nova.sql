DROP INDEX "concepts_org_name_uq";--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_name_uq" ON "concepts" USING btree ("org_id","name") WHERE "concepts"."deleted_at" IS NULL;