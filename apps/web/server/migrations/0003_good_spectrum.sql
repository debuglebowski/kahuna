CREATE TABLE "linear_audit_log" (
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
CREATE TABLE "linear_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text,
	"webhook_token" text,
	"webhook_secret" text,
	"viewer_id" text,
	"viewer_name" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"linear_id" text NOT NULL,
	"identifier" text,
	"title" text,
	"state" text,
	"state_type" text,
	"assignee_id" text,
	"assignee_name" text,
	"team_id" text,
	"team_key" text,
	"priority" integer,
	"url" text,
	"updated_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"connection_id" uuid,
	"dedupe_key" text NOT NULL,
	"action" text,
	"entity_type" text,
	"entity_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_connection" ADD CONSTRAINT "linear_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_connection" ADD CONSTRAINT "linear_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue" ADD CONSTRAINT "linear_issue_connection_id_linear_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."linear_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linear_audit_log_org_idx" ON "linear_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connection_org_uq" ON "linear_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connection_webhook_token_uq" ON "linear_connection" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "linear_connection_status_idx" ON "linear_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_org_linear_uq" ON "linear_issue" USING btree ("org_id","linear_id");--> statement-breakpoint
CREATE INDEX "linear_issue_org_identifier_idx" ON "linear_issue" USING btree ("org_id","identifier");--> statement-breakpoint
CREATE INDEX "linear_issue_org_state_idx" ON "linear_issue" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_webhook_event_dedupe_uq" ON "linear_webhook_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "linear_webhook_event_org_idx" ON "linear_webhook_event" USING btree ("org_id","received_at");