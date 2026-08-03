CREATE TABLE "access_policy_versions" (
	"org_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_role_actors" (
	"org_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_role_actors_role_id_actor_id_pk" PRIMARY KEY("role_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "access_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"description" text,
	"builtin" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"role_id" uuid,
	"actor_id" text,
	"effect" text DEFAULT 'allow' NOT NULL,
	"actions" text[] NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"concept_id" uuid,
	"condition" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_rules_one_subject" CHECK (("access_rules"."role_id" IS NULL) <> ("access_rules"."actor_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "access_role_actors" ADD CONSTRAINT "access_role_actors_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_role_actors_actor_idx" ON "access_role_actors" USING btree ("org_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_roles_key_uq" ON "access_roles" USING btree ("org_id","key") WHERE "access_roles"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "access_roles_org_idx" ON "access_roles" USING btree ("org_id","position");--> statement-breakpoint
CREATE INDEX "access_rules_role_idx" ON "access_rules" USING btree ("org_id","role_id") WHERE "access_rules"."role_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "access_rules_actor_idx" ON "access_rules" USING btree ("org_id","actor_id") WHERE "access_rules"."actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "access_rules_resource_idx" ON "access_rules" USING btree ("org_id","resource_type","resource_id");