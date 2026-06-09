ALTER TABLE "concepts" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
ALTER TABLE "fields" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
ALTER TABLE "labels" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
ALTER TABLE "relations" RENAME COLUMN "deleted_at" TO "archived_at";
