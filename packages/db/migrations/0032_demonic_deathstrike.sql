ALTER TABLE "dashboards" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "concept_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "dashboards_concept_idx" ON "dashboards" USING btree ("org_id","concept_id") WHERE "dashboards"."kind" = 'record';--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_concept_default_uq" ON "dashboards" USING btree ("concept_id") WHERE "dashboards"."kind" = 'record' AND "dashboards"."is_default";