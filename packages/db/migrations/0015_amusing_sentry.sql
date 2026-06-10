CREATE TABLE "instance_view_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"body" jsonb DEFAULT '{"defaultView":null,"byConcept":{}}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_view_prefs_org_user_uq" ON "instance_view_prefs" USING btree ("org_id","user_id");