CREATE TABLE "clay_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" uuid,
	"action" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clay_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"table_webhook_url" text,
	"api_key" text,
	"callback_secret" text,
	"new_row_concept_id" text,
	"new_row_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clay_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"instance_id" text,
	"concept_id" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"direction" text DEFAULT 'enrich' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clay_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"connection_id" uuid,
	"dedupe_key" text NOT NULL,
	"job_id" text,
	"kind" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clay_connection" ADD CONSTRAINT "clay_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_connection" ADD CONSTRAINT "clay_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_job" ADD CONSTRAINT "clay_job_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_job" ADD CONSTRAINT "clay_job_connection_id_clay_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."clay_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clay_audit_log_org_idx" ON "clay_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clay_connection_org_uq" ON "clay_connection" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clay_connection_status_idx" ON "clay_connection" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clay_job_org_idx" ON "clay_job" USING btree ("org_id","pushed_at");--> statement-breakpoint
CREATE INDEX "clay_job_status_idx" ON "clay_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clay_job_instance_idx" ON "clay_job" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clay_notification_dedupe_uq" ON "clay_notification" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "clay_notification_org_idx" ON "clay_notification" USING btree ("org_id","received_at");