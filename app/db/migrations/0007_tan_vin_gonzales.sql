CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"from_instance_id" uuid,
	"from_field_id" uuid,
	"from_annotation_id" uuid,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_from_instance_id_instances_id_fk" FOREIGN KEY ("from_instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_from_field_id_fields_id_fk" FOREIGN KEY ("from_field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_from_annotation_id_annotations_id_fk" FOREIGN KEY ("from_annotation_id") REFERENCES "public"."annotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_target_item_id_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentions_target_item_idx" ON "mentions" USING btree ("org_id","target_item_id");--> statement-breakpoint
CREATE INDEX "mentions_from_instance_idx" ON "mentions" USING btree ("org_id","from_instance_id");--> statement-breakpoint
CREATE INDEX "mentions_from_annotation_idx" ON "mentions" USING btree ("org_id","from_annotation_id");--> statement-breakpoint
CREATE INDEX "mentions_target_idx" ON "mentions" USING btree ("org_id","kind","target_id");--> statement-breakpoint
-- Hand-added: drizzle's table builder cannot express a CHECK across columns, so
-- this mirrors the `attachments_one_owner` precedent. A mention row comes from
-- exactly one rich-text home — an instance's richtext field, or a task description.
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_one_source" CHECK (
	(from_instance_id IS NOT NULL AND from_annotation_id IS NULL)
	OR (from_instance_id IS NULL AND from_annotation_id IS NOT NULL)
);