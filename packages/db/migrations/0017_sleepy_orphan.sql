CREATE TABLE "instance_graph_layouts" (
	"org_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"positions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_graph_layouts_org_id_item_id_pk" PRIMARY KEY("org_id","item_id")
);
