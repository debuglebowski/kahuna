CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_ref" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"formula" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_id_instances_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_id_instances_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_name_uq" ON "concepts" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_id","id");--> statement-breakpoint
CREATE INDEX "events_org_idx" ON "events" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_concept_name_uq" ON "fields" USING btree ("concept_id","name");--> statement-breakpoint
CREATE INDEX "instances_org_concept_idx" ON "instances" USING btree ("org_id","concept_id");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("org_id","from_id","relation_type");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "relations" USING btree ("org_id","to_id","relation_type");--> statement-breakpoint
CREATE INDEX "instances_state_gin" ON "instances" USING gin ("state" jsonb_path_ops);