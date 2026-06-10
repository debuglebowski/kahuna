CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "versioning_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "version_status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "version_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN "to_item_id" uuid;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN "to_version_id" uuid;--> statement-breakpoint
-- Backfill: every existing instance becomes a 1:1 published seq-1 lineage
-- (items.id = instances.id), so "latest published per item" is an identity
-- no-op for pre-versioning data. published_at mirrors created_at, matching
-- what a full event replay would compute for a legacy InstanceCreated.
INSERT INTO "items" ("id", "org_id", "concept_id", "created_at")
SELECT "id", "org_id", "concept_id", "created_at" FROM "instances";--> statement-breakpoint
UPDATE "instances" SET "item_id" = "id" WHERE "item_id" IS NULL;--> statement-breakpoint
UPDATE "instances" SET "published_at" = "created_at" WHERE "published_at" IS NULL;--> statement-breakpoint
-- Existing edges become general ("Latest") refs to the target's lineage
-- (item_id = to_id after the 1:1 backfill); to_version_id stays NULL.
UPDATE "relations" SET "to_item_id" = "to_id" WHERE "to_item_id" IS NULL;--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "item_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relations" ALTER COLUMN "to_item_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_org_concept_idx" ON "items" USING btree ("org_id","concept_id");--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_item_id_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_version_id_instances_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instances_head_idx" ON "instances" USING btree ("org_id","concept_id","item_id","version_seq" DESC NULLS LAST) WHERE "instances"."version_status" = 'published' AND "instances"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "instances_item_idx" ON "instances" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_item_seq_uq" ON "instances" USING btree ("item_id","version_seq");--> statement-breakpoint
CREATE INDEX "relations_to_item_idx" ON "relations" USING btree ("org_id","to_item_id","field_id");--> statement-breakpoint
CREATE INDEX "relations_to_version_idx" ON "relations" USING btree ("org_id","to_version_id");
