CREATE TABLE "member_deactivations" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"deactivated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"body" jsonb DEFAULT '{"widgets":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "member_deactivations_org_user_uq" ON "member_deactivations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_pages_org_user_uq" ON "member_pages" USING btree ("org_id","user_id");