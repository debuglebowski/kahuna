CREATE TABLE "org_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"default_currency" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
