CREATE TABLE "slack_audit_log" (
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
CREATE TABLE "slack_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"name" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"enterprise_id" text,
	"app_id" text,
	"bot_user_id" text,
	"authed_user_id" text,
	"bot_token" text,
	"scopes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"connection_id" uuid,
	"dedupe_key" text NOT NULL,
	"team_id" text,
	"event_type" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_oauth_state" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"return_to" text DEFAULT '/settings/integrations' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_channel" ADD CONSTRAINT "slack_channel_connection_id_slack_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."slack_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connection" ADD CONSTRAINT "slack_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connection" ADD CONSTRAINT "slack_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_audit_log_org_idx" ON "slack_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channel_conn_channel_uq" ON "slack_channel" USING btree ("connection_id","channel_id");--> statement-breakpoint
CREATE INDEX "slack_channel_org_name_idx" ON "slack_channel" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connection_org_uq" ON "slack_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connection_team_uq" ON "slack_connection" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_connection_status_idx" ON "slack_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_event_dedupe_uq" ON "slack_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "slack_event_org_idx" ON "slack_event" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "slack_oauth_state_exp_idx" ON "slack_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "slack_oauth_state_user_idx" ON "slack_oauth_state" USING btree ("org_id","user_id");