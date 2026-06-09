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
CREATE INDEX "sidebar_views_org_owner_idx" ON "sidebar_views" USING btree ("org_id","owner_id");