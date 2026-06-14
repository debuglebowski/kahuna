CREATE TABLE "posthog_audit_log" (
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
CREATE TABLE "posthog_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"host" text NOT NULL,
	"region" text DEFAULT 'us' NOT NULL,
	"project_id" text NOT NULL,
	"project_name" text,
	"api_key" text,
	"webhook_token" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posthog_person_metric" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"distinct_id" text NOT NULL,
	"person_id" text,
	"email" text,
	"name" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posthog_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"connection_id" uuid,
	"dedupe_key" text NOT NULL,
	"event_name" text,
	"distinct_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posthog_connection" ADD CONSTRAINT "posthog_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posthog_connection" ADD CONSTRAINT "posthog_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posthog_person_metric" ADD CONSTRAINT "posthog_person_metric_connection_id_posthog_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."posthog_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posthog_audit_log_org_idx" ON "posthog_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_connection_org_uq" ON "posthog_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_connection_webhook_token_uq" ON "posthog_connection" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "posthog_connection_status_idx" ON "posthog_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_person_metric_org_distinct_uq" ON "posthog_person_metric" USING btree ("org_id","distinct_id");--> statement-breakpoint
CREATE INDEX "posthog_person_metric_email_idx" ON "posthog_person_metric" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_webhook_event_dedupe_uq" ON "posthog_webhook_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "posthog_webhook_event_org_idx" ON "posthog_webhook_event" USING btree ("org_id","received_at");