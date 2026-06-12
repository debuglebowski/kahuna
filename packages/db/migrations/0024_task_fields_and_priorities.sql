CREATE TABLE "task_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "description" jsonb;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "priority_id" uuid;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "blocked_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "task_priorities_org_name_uq" ON "task_priorities" USING btree ("org_id","name") WHERE "task_priorities"."archived_at" IS NULL;--> statement-breakpoint
-- Data migration: seed the default priority set for every org that already has
-- task statuses (= every org the annotation substrate touched). New orgs get
-- the same set via seedKingsmaker's ensureDefaults; this covers existing ones.
INSERT INTO "task_priorities" ("org_id", "name", "color", "position")
SELECT o.org_id, p.name, p.color, p.position
FROM (SELECT DISTINCT org_id FROM "task_statuses") o
CROSS JOIN (
  VALUES
    ('Urgent', '#ef4444', 0),
    ('High', '#f97316', 1),
    ('Medium', '#f59e0b', 2),
    ('Low', '#3b82f6', 3),
    ('Someday', '#6b7280', 4)
) AS p(name, color, position)
WHERE NOT EXISTS (SELECT 1 FROM "task_priorities" t WHERE t.org_id = o.org_id);