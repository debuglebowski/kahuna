ALTER TABLE "attachments" ADD COLUMN "item_id" uuid;--> statement-breakpoint
UPDATE "attachments" a SET "item_id" = i."item_id" FROM "instances" i WHERE a."instance_id" = i."id";--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "item_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_item_idx" ON "attachments" USING btree ("org_id","item_id","id");--> statement-breakpoint
CREATE INDEX "attachments_org_idx" ON "attachments" USING btree ("org_id","id");
