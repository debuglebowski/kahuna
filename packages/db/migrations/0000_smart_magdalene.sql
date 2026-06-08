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
	"slug" text NOT NULL,
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
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone
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
	"field_id" uuid NOT NULL,
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
ALTER TABLE "relations" ADD CONSTRAINT "relations_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_id_instances_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_id_instances_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_name_uq" ON "concepts" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_slug_uq" ON "concepts" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_id","id");--> statement-breakpoint
CREATE INDEX "events_org_idx" ON "events" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_concept_name_uq" ON "fields" USING btree ("concept_id","name") WHERE "fields"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "instances_org_concept_idx" ON "instances" USING btree ("org_id","concept_id");--> statement-breakpoint
CREATE INDEX "instances_state_gin" ON "instances" USING gin ("state" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("org_id","from_id","field_id");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "relations" USING btree ("org_id","to_id","field_id");--> statement-breakpoint
-- Readability view: instance.state is keyed by field id; this resolves each key
-- to its current field name (joining soft-deleted fields too) for psql/debugging.
-- Synthetic keys like `__bands` are not uuids → shown verbatim.
CREATE VIEW "instance_state_readable" AS
SELECT
  i.id AS instance_id,
  i.org_id AS org_id,
  c.name AS concept_name,
  COALESCE(f.name, kv.key) AS field,
  kv.value AS value
FROM instances i
JOIN concepts c ON c.id = i.concept_id
CROSS JOIN LATERAL jsonb_each(i.state) AS kv(key, value)
LEFT JOIN fields f
  ON f.org_id = i.org_id
  AND f.id = (
    CASE WHEN kv.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN kv.key::uuid END
  )
WHERE i.deleted_at IS NULL;