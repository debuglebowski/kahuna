ALTER TABLE "access_roles" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "auto_assign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Carry `builtin` across before 0010 drops it. Hand-written: drizzle-kit only ever
-- emits DDL, and the rename would otherwise arrive as drop-then-add, silently
-- resetting every seeded role to unmanaged (i.e. deletable).
UPDATE "access_roles" SET "managed" = "builtin";--> statement-breakpoint
-- Categorise and set the landing zones for the roles the seed already made. Keyed on
-- `key`, which is the only thing that pins a seeded row; a renamed one still matches.
UPDATE "access_roles" SET "kind" = 'automation' WHERE "key" = 'automation_full';--> statement-breakpoint
UPDATE "access_roles" SET "auto_assign" = true WHERE "key" IN ('member', 'automation_full');