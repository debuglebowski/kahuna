ALTER TABLE "attachments" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "bucket_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "bucket_shared" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_bucket_idx" ON "attachments" USING btree ("org_id","bucket_id","id") WHERE "attachments"."bucket_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_owner" CHECK (("attachments"."item_id" IS NULL) <> ("attachments"."bucket_id" IS NULL));