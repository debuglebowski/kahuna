CREATE TABLE "concept_graph_layouts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"positions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
