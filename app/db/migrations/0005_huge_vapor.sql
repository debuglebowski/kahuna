CREATE TABLE "org_auth_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"password_enabled" boolean DEFAULT true NOT NULL,
	"sso_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bauth_sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	CONSTRAINT "bauth_sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "org_auth_settings" ADD CONSTRAINT "org_auth_settings_org_id_bauth_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_sso_provider" ADD CONSTRAINT "bauth_sso_provider_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bauth_sso_provider" ADD CONSTRAINT "bauth_sso_provider_organization_id_bauth_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."bauth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_org_uq" ON "bauth_sso_provider" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sso_provider_domain_idx" ON "bauth_sso_provider" USING btree ("domain");