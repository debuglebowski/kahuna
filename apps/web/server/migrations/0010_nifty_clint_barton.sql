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
ALTER TABLE "slack_oauth_state" ADD COLUMN "kind" text DEFAULT 'install' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_user_connection" ADD CONSTRAINT "slack_user_connection_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_connection" ADD CONSTRAINT "slack_user_connection_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_connection_org_user_uq" ON "slack_user_connection" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "slack_user_connection_status_idx" ON "slack_user_connection" USING btree ("status");