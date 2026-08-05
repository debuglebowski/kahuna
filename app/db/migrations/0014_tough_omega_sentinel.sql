ALTER TABLE "access_role_actors" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "based_on" uuid;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "personal_for" text;--> statement-breakpoint
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_based_on_access_roles_id_fk" FOREIGN KEY ("based_on") REFERENCES "public"."access_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_roles_personal_for_uq" ON "access_roles" USING btree ("org_id","personal_for") WHERE "access_roles"."personal_for" IS NOT NULL;