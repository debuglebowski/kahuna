CREATE TABLE "access_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"actions" text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "full_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "access_defaults" ADD CONSTRAINT "access_defaults_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_defaults_role_type_effect_uq" ON "access_defaults" USING btree ("role_id","resource_type","effect");--> statement-breakpoint
CREATE INDEX "access_defaults_org_idx" ON "access_defaults" USING btree ("org_id","resource_type");