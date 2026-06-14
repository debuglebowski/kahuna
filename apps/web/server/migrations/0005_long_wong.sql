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
ALTER TABLE "apollo_connection" ADD CONSTRAINT "apollo_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apollo_connection" ADD CONSTRAINT "apollo_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apollo_enrichment_cache" ADD CONSTRAINT "apollo_enrichment_cache_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apollo_audit_log_org_idx" ON "apollo_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "apollo_connection_org_uq" ON "apollo_connection" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "apollo_connection_status_idx" ON "apollo_connection" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "apollo_enrichment_cache_org_key_uq" ON "apollo_enrichment_cache" USING btree ("org_id","lookup_key");--> statement-breakpoint
CREATE INDEX "apollo_enrichment_cache_fetched_idx" ON "apollo_enrichment_cache" USING btree ("org_id","fetched_at");