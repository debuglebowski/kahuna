ALTER TABLE "attachments" DROP CONSTRAINT "attachments_instance_id_instances_id_fk";
--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "instance_id";