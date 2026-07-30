-- Squashed baseline. Replaces the 48 migrations that existed before the workspace
-- collapse (37 engine + 11 BetterAuth/integration), which lived in
-- packages/db/migrations and apps/web/server/migrations. Both sets are reachable
-- in git history at 8ad39b1; the ledger post-mortem that motivated the squash is
-- at e4dc17a and summarised in ../../drizzle.config.ts.
--
-- Verified schema-identical to those 48 by catalog diff (columns, indexes,
-- constraints, sequences) — the only difference was the hand-written view at the
-- end of this file, which is preserved here.
--
-- DROPPED in the squash: five pure-data migrations that retrofitted existing
-- `sidebar_views.body` rows to new shapes (0014_members_static_item,
-- 0019_tasks_static_item, 0022_sidebar_dashboard_sections, 0023_sidebar_entry_ids,
-- 0025_sidebar_globals_section). They contained no DDL and are permanent no-ops
-- against a fresh database: new orgs get the current shape from
-- SidebarViewService's seed. The only database that had pre-0022 bodies was dev,
-- whose already-migrated rows were preserved through a data-only dump/restore.

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
	"description" jsonb,
	"priority_id" uuid,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snoozed_until" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"blocked_by_task_id" uuid,
	"completed_at" timestamp with time zone,
	"created_by" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"item_id" uuid,
	"bucket_id" uuid,
	"bucket_shared" boolean DEFAULT true NOT NULL,
	"filename" text NOT NULL,
	"content_ref" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "attachments_one_owner" CHECK (("attachments"."item_id" IS NULL) <> ("attachments"."bucket_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "concept_graph_layouts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"positions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"plural_name" text,
	"description" text,
	"icon" text,
	"color" text,
	"managed_by" text,
	"static_label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"versioning_enabled" boolean DEFAULT false NOT NULL,
	"edit_reach" text DEFAULT 'draft' NOT NULL,
	"single_record" boolean DEFAULT false NOT NULL,
	"instance_view" jsonb,
	"title_field_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'page' NOT NULL,
	"concept_id" uuid,
	"body" jsonb DEFAULT '{"widgets":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"managed_by" text,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "instance_graph_layouts" (
	"org_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"positions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_graph_layouts_org_id_item_id_pk" PRIMARY KEY("org_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "instance_view_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"body" jsonb DEFAULT '{"defaultView":null,"byConcept":{}}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"version_status" text DEFAULT 'published' NOT NULL,
	"version_seq" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member_deactivations" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"deactivated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"field_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_item_id" uuid NOT NULL,
	"to_version_id" uuid,
	"to_id" uuid NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sidebar_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"body" jsonb DEFAULT '{"sections":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
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
CREATE TABLE "bauth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apollo_audit_log" (
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
CREATE TABLE "apollo_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"api_key" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apollo_enrichment_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"person" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"concept_id" text,
	"field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gmail_concept_id" text,
	"gmail_field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
CREATE TABLE "bauth_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
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
	"concept_id" text,
	"field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
CREATE TABLE "bauth_member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bauth_organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "bauth_organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
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
CREATE TABLE "bauth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "bauth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
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
	"kind" text DEFAULT 'install' NOT NULL,
	"return_to" text DEFAULT '/settings/integrations' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text,
	"slack_user_name" text,
	"user_token" text,
	"scopes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bauth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bauth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "bauth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_id_instances_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_item_id_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_version_id_instances_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_id_instances_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_account" ADD CONSTRAINT "bauth_account_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apollo_connection" ADD CONSTRAINT "apollo_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apollo_connection" ADD CONSTRAINT "apollo_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apollo_enrichment_cache" ADD CONSTRAINT "apollo_enrichment_cache_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_connection" ADD CONSTRAINT "clay_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_connection" ADD CONSTRAINT "clay_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_job" ADD CONSTRAINT "clay_job_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clay_job" ADD CONSTRAINT "clay_job_connection_id_clay_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."clay_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_event" ADD CONSTRAINT "google_calendar_event_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_sync" ADD CONSTRAINT "google_calendar_sync_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_message" ADD CONSTRAINT "google_gmail_message_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_sync" ADD CONSTRAINT "google_gmail_sync_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_gmail_thread" ADD CONSTRAINT "google_gmail_thread_connection_id_google_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_invitation" ADD CONSTRAINT "bauth_invitation_organization_id_bauth_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_invitation" ADD CONSTRAINT "bauth_invitation_inviter_id_bauth_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_connection" ADD CONSTRAINT "linear_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_connection" ADD CONSTRAINT "linear_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue" ADD CONSTRAINT "linear_issue_connection_id_linear_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."linear_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_member" ADD CONSTRAINT "bauth_member_organization_id_bauth_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_member" ADD CONSTRAINT "bauth_member_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posthog_connection" ADD CONSTRAINT "posthog_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posthog_connection" ADD CONSTRAINT "posthog_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posthog_person_metric" ADD CONSTRAINT "posthog_person_metric_connection_id_posthog_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."posthog_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_session" ADD CONSTRAINT "bauth_session_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channel" ADD CONSTRAINT "slack_channel_connection_id_slack_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."slack_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connection" ADD CONSTRAINT "slack_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connection" ADD CONSTRAINT "slack_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_connection" ADD CONSTRAINT "slack_user_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_connection" ADD CONSTRAINT "slack_user_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "annotation_fields_type_name_uq" ON "annotation_fields" USING btree ("org_id","annotation_type","name") WHERE "annotation_fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "annotations_subject_idx" ON "annotations" USING btree ("org_id","subject_id","type","id");--> statement-breakpoint
CREATE INDEX "annotations_assignee_idx" ON "annotations" USING btree ("org_id","assignee","status_id","due_at") WHERE "annotations"."type" = 'task' AND "annotations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "annotations_due_idx" ON "annotations" USING btree ("org_id","due_at") WHERE "annotations"."type" = 'task' AND "annotations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "attachments_item_idx" ON "attachments" USING btree ("org_id","item_id","id");--> statement-breakpoint
CREATE INDEX "attachments_bucket_idx" ON "attachments" USING btree ("org_id","bucket_id","id") WHERE "attachments"."bucket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_org_idx" ON "attachments" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_name_uq" ON "concepts" USING btree ("org_id","name") WHERE "concepts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_org_slug_uq" ON "concepts" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "dashboards_org_owner_idx" ON "dashboards" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "dashboards_concept_idx" ON "dashboards" USING btree ("org_id","concept_id") WHERE "dashboards"."kind" = 'record';--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_id","id");--> statement-breakpoint
CREATE INDEX "events_org_idx" ON "events" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_concept_name_uq" ON "fields" USING btree ("concept_id","name") WHERE "fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_view_prefs_org_user_uq" ON "instance_view_prefs" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "instances_org_concept_idx" ON "instances" USING btree ("org_id","concept_id");--> statement-breakpoint
CREATE INDEX "instances_state_gin" ON "instances" USING gin ("state" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "instances_head_idx" ON "instances" USING btree ("org_id","concept_id","item_id","version_seq" DESC NULLS LAST) WHERE "instances"."version_status" = 'published' AND "instances"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "instances_item_idx" ON "instances" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_item_seq_uq" ON "instances" USING btree ("item_id","version_seq");--> statement-breakpoint
CREATE INDEX "items_org_concept_idx" ON "items" USING btree ("org_id","concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_org_name_uq" ON "labels" USING btree ("org_id","name") WHERE "labels"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_deactivations_org_user_uq" ON "member_deactivations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("org_id","from_id","field_id");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "relations" USING btree ("org_id","to_id","field_id");--> statement-breakpoint
CREATE INDEX "relations_to_item_idx" ON "relations" USING btree ("org_id","to_item_id","field_id");--> statement-breakpoint
CREATE INDEX "relations_to_version_idx" ON "relations" USING btree ("org_id","to_version_id");--> statement-breakpoint
CREATE INDEX "sidebar_views_org_owner_idx" ON "sidebar_views" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_priorities_org_name_uq" ON "task_priorities" USING btree ("org_id","name") WHERE "task_priorities"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_statuses_org_name_uq" ON "task_statuses" USING btree ("org_id","name") WHERE "task_statuses"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "bauth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apollo_audit_log_org_idx" ON "apollo_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "apollo_connection_org_uq" ON "apollo_connection" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "apollo_connection_status_idx" ON "apollo_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "apollo_enrichment_cache_org_key_uq" ON "apollo_enrichment_cache" USING btree ("org_id","lookup_key");--> statement-breakpoint
CREATE INDEX "apollo_enrichment_cache_fetched_idx" ON "apollo_enrichment_cache" USING btree ("org_id","fetched_at");--> statement-breakpoint
CREATE INDEX "clay_audit_log_org_idx" ON "clay_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clay_connection_org_uq" ON "clay_connection" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clay_connection_status_idx" ON "clay_connection" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clay_job_org_idx" ON "clay_job" USING btree ("org_id","pushed_at");--> statement-breakpoint
CREATE INDEX "clay_job_status_idx" ON "clay_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clay_job_instance_idx" ON "clay_job" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clay_notification_dedupe_uq" ON "clay_notification" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "clay_notification_org_idx" ON "clay_notification" USING btree ("org_id","received_at");--> statement-breakpoint
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
CREATE INDEX "google_object_link_item_idx" ON "google_object_link" USING btree ("org_id","item_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "bauth_invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "bauth_invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "linear_audit_log_org_idx" ON "linear_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connection_org_uq" ON "linear_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connection_webhook_token_uq" ON "linear_connection" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "linear_connection_status_idx" ON "linear_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_org_linear_uq" ON "linear_issue" USING btree ("org_id","linear_id");--> statement-breakpoint
CREATE INDEX "linear_issue_org_identifier_idx" ON "linear_issue" USING btree ("org_id","identifier");--> statement-breakpoint
CREATE INDEX "linear_issue_org_state_idx" ON "linear_issue" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_webhook_event_dedupe_uq" ON "linear_webhook_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "linear_webhook_event_org_idx" ON "linear_webhook_event" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "bauth_member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "bauth_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "bauth_organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "posthog_audit_log_org_idx" ON "posthog_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_connection_org_uq" ON "posthog_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_connection_webhook_token_uq" ON "posthog_connection" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "posthog_connection_status_idx" ON "posthog_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_person_metric_org_distinct_uq" ON "posthog_person_metric" USING btree ("org_id","distinct_id");--> statement-breakpoint
CREATE INDEX "posthog_person_metric_email_idx" ON "posthog_person_metric" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "posthog_webhook_event_dedupe_uq" ON "posthog_webhook_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "posthog_webhook_event_org_idx" ON "posthog_webhook_event" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "bauth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slack_audit_log_org_idx" ON "slack_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channel_conn_channel_uq" ON "slack_channel" USING btree ("connection_id","channel_id");--> statement-breakpoint
CREATE INDEX "slack_channel_org_name_idx" ON "slack_channel" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connection_org_uq" ON "slack_connection" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connection_team_uq" ON "slack_connection" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_connection_status_idx" ON "slack_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_event_dedupe_uq" ON "slack_event" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "slack_event_org_idx" ON "slack_event" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "slack_oauth_state_exp_idx" ON "slack_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "slack_oauth_state_user_idx" ON "slack_oauth_state" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_connection_org_user_uq" ON "slack_user_connection" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "slack_user_connection_status_idx" ON "slack_user_connection" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "bauth_verification" USING btree ("identifier");--> statement-breakpoint
-- HAND-APPENDED, not drizzle-generated. `instance_state_readable` is a debugging
-- convenience view (renders each instance's jsonb state one row per field, with
-- field UUIDs resolved to human-readable names). It predates this baseline —
-- it came from the original 0000_smart_magdalene.sql — and drizzle cannot emit
-- it because the schema files never declare it via `pgView`. Squashing without
-- this block would have silently dropped it; the pre-flight catalog diff between
-- the old 48 migrations and this baseline flagged exactly these 5 columns as the
-- only difference. Keep it here so the baseline stays a true superset.
-- Invisible to `drizzle-kit generate`, so it does not cause schema drift.
-- NB: the predicate is `archived_at`, not the `deleted_at` the original 0000
-- used — 0007_rename_archived_at renamed the column and Postgres rewrote the
-- view's stored definition in place. Taken from pg_get_viewdef() on a database
-- built from all 48 old migrations, not from the original 0000 text.
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
WHERE i.archived_at IS NULL;
