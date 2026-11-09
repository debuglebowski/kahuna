CREATE TABLE "idp_role_activation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"fingerprint" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idp_role_identities" (
	"user_id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"epoch" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"verified_at" bigint,
	"denied_at" bigint,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refresh_token" text,
	"fingerprint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idp_role_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idp_role_identities" ADD CONSTRAINT "idp_role_identities_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_role_sessions" ADD CONSTRAINT "idp_role_sessions_session_id_bauth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bauth_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_role_sessions" ADD CONSTRAINT "idp_role_sessions_user_id_bauth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."bauth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idp_role_identities_subject_idx" ON "idp_role_identities" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "idp_role_sessions_user_idx" ON "idp_role_sessions" USING btree ("user_id");