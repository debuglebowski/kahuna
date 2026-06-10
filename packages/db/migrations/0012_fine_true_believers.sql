CREATE TABLE "annotation_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"annotation_type" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"subject_id" uuid,
	"subject_kind" text,
	"body" text,
	"title" text,
	"status_id" uuid,
	"assignee" text,
	"due_at" timestamp with time zone,
	"created_by" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"category" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "annotation_fields_type_name_uq" ON "annotation_fields" USING btree ("org_id","annotation_type","name") WHERE "annotation_fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "annotations_subject_idx" ON "annotations" USING btree ("org_id","subject_id","type","id");--> statement-breakpoint
CREATE INDEX "annotations_assignee_idx" ON "annotations" USING btree ("org_id","assignee","status_id","due_at") WHERE "annotations"."type" = 'task' AND "annotations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "annotations_due_idx" ON "annotations" USING btree ("org_id","due_at") WHERE "annotations"."type" = 'task' AND "annotations"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_statuses_org_name_uq" ON "task_statuses" USING btree ("org_id","name") WHERE "task_statuses"."archived_at" IS NULL;