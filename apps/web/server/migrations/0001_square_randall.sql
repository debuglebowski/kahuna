CREATE TABLE "google_audit_log" (
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
CREATE TABLE "google_calendar_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"google_event_id" text NOT NULL,
	"etag" text,
	"status" text,
	"summary" text,
	"description" text,
	"location" text,
	"html_link" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"google_updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"sync_token" text,
	"watch_channel_id" text,
	"watch_resource_id" text,
	"watch_token" text,
	"watch_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"google_account_id" text,
	"email" text,
	"scopes" text DEFAULT '' NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_gmail_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"history_id" text,
	"subject" text,
	"from_email" text,
	"to_email" text,
	"sent_at" timestamp with time zone,
	"snippet" text,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_text" text,
	"body_html" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_gmail_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"history_id" text,
	"watch_expiration" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_gmail_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"history_id" text,
	"subject" text,
	"snippet" text,
	"from_email" text,
	"last_message_at" timestamp with time zone,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_notification" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_oauth_state" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"return_to" text DEFAULT '/settings/integrations' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_object_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"item_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_event" ADD CONSTRAINT "google_calendar_event_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_sync" ADD CONSTRAINT "google_calendar_sync_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_message" ADD CONSTRAINT "google_gmail_message_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_sync" ADD CONSTRAINT "google_gmail_sync_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_thread" ADD CONSTRAINT "google_gmail_thread_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_audit_log_org_idx" ON "google_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_event_provider_uq" ON "google_calendar_event" USING btree ("connection_id","calendar_id","google_event_id");--> statement-breakpoint
CREATE INDEX "google_calendar_event_list_idx" ON "google_calendar_event" USING btree ("org_id","user_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_sync_conn_calendar_uq" ON "google_calendar_sync" USING btree ("connection_id","calendar_id");--> statement-breakpoint
CREATE INDEX "google_calendar_watch_exp_idx" ON "google_calendar_sync" USING btree ("watch_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_connection_org_user_uq" ON "google_connection" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "google_connection_status_idx" ON "google_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "google_gmail_message_provider_uq" ON "google_gmail_message" USING btree ("connection_id","message_id");--> statement-breakpoint
CREATE INDEX "google_gmail_message_thread_idx" ON "google_gmail_message" USING btree ("connection_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_gmail_sync_conn_uq" ON "google_gmail_sync" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "google_gmail_watch_exp_idx" ON "google_gmail_sync" USING btree ("watch_expiration");--> statement-breakpoint
CREATE UNIQUE INDEX "google_gmail_thread_provider_uq" ON "google_gmail_thread" USING btree ("connection_id","thread_id");--> statement-breakpoint
CREATE INDEX "google_gmail_thread_list_idx" ON "google_gmail_thread" USING btree ("org_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "google_notification_exp_idx" ON "google_notification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "google_oauth_state_exp_idx" ON "google_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "google_oauth_state_user_idx" ON "google_oauth_state" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_object_link_uq" ON "google_object_link" USING btree ("org_id","user_id","provider_kind","provider_id","item_id");--> statement-breakpoint
CREATE INDEX "google_object_link_item_idx" ON "google_object_link" USING btree ("org_id","item_id");