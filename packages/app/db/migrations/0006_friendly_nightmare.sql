CREATE TABLE "org_integration_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"google_sync_enabled" boolean,
	"google_watch_enabled" boolean,
	"slack_sync_enabled" boolean,
	"posthog_sync_enabled" boolean,
	"linear_sync_enabled" boolean,
	"apollo_enrich_cache_enabled" boolean,
	"apollo_enrich_cache_ttl_days" integer,
	"analytics_cache_ttl_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_integration_settings" ADD CONSTRAINT "org_integration_settings_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;