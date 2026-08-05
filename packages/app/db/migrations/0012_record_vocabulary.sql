-- Rename the "item"/"instance" vocabulary to "record"/"recordVersion" —
-- matches app/db/schema.ts + app/db/auth-schema.ts, already committed and
-- typechecked against the code in this same change.
--
-- Order: drop the hand-appended debugging view (its column ALIAS doesn't
-- survive a table/column rename, unlike the view's FROM-clause reference,
-- which Postgres tracks by OID and would keep working either way) -> rename
-- tables -> columns -> indexes -> FK constraints -> the one composite PK ->
-- data (subject_kind, event tags, payload keys, dashboards.body) -> recreate
-- the view under its new name and alias.
--
-- CHECK constraints (attachments_one_owner, mentions_one_source) are NOT
-- touched here: Postgres rewrites a CHECK's stored expression automatically
-- when a column it references is renamed. Verified against
-- pg_get_constraintdef after a dry run.

DROP VIEW "instance_state_readable";
--> statement-breakpoint

-- ── tables ────────────────────────────────────────────────────────────────
ALTER TABLE "instances" RENAME TO "record_versions";
--> statement-breakpoint
ALTER TABLE "items" RENAME TO "records";
--> statement-breakpoint
ALTER TABLE "instance_view_prefs" RENAME TO "record_view_prefs";
--> statement-breakpoint
ALTER TABLE "instance_graph_layouts" RENAME TO "record_graph_layouts";
--> statement-breakpoint

-- ── columns ───────────────────────────────────────────────────────────────
-- relations.from_id is NOT renamed — it was never item/instance-named (see
-- schema.ts); only its FK target table changes, which RENAME TABLE already
-- handled. relations.to_id (the legacy shadow column) is the same case.
ALTER TABLE "record_versions" RENAME COLUMN "item_id" TO "record_id";
--> statement-breakpoint
ALTER TABLE "relations" RENAME COLUMN "to_item_id" TO "to_record_id";
--> statement-breakpoint
ALTER TABLE "mentions" RENAME COLUMN "from_instance_id" TO "from_version_id";
--> statement-breakpoint
ALTER TABLE "mentions" RENAME COLUMN "target_item_id" TO "target_record_id";
--> statement-breakpoint
ALTER TABLE "attachments" RENAME COLUMN "item_id" TO "record_id";
--> statement-breakpoint
ALTER TABLE "record_graph_layouts" RENAME COLUMN "item_id" TO "record_id";
--> statement-breakpoint
ALTER TABLE "concepts" RENAME COLUMN "instance_view" TO "record_view";
--> statement-breakpoint
ALTER TABLE "clay_job" RENAME COLUMN "instance_id" TO "record_version_id";
--> statement-breakpoint
ALTER TABLE "google_object_link" RENAME COLUMN "item_id" TO "record_id";
--> statement-breakpoint

-- ── indexes (Postgres does not rename these on a table/column rename) ─────
ALTER INDEX "instances_org_concept_idx" RENAME TO "record_versions_org_concept_idx";
--> statement-breakpoint
ALTER INDEX "instances_state_gin" RENAME TO "record_versions_state_gin";
--> statement-breakpoint
ALTER INDEX "instances_head_idx" RENAME TO "record_versions_head_idx";
--> statement-breakpoint
ALTER INDEX "instances_item_idx" RENAME TO "record_versions_record_idx";
--> statement-breakpoint
ALTER INDEX "instances_item_seq_uq" RENAME TO "record_versions_record_seq_uq";
--> statement-breakpoint
ALTER INDEX "items_org_concept_idx" RENAME TO "records_org_concept_idx";
--> statement-breakpoint
ALTER INDEX "instance_view_prefs_org_user_uq" RENAME TO "record_view_prefs_org_user_uq";
--> statement-breakpoint
ALTER INDEX "relations_to_item_idx" RENAME TO "relations_to_record_idx";
--> statement-breakpoint
ALTER INDEX "mentions_target_item_idx" RENAME TO "mentions_target_record_idx";
--> statement-breakpoint
ALTER INDEX "mentions_from_instance_idx" RENAME TO "mentions_from_version_idx";
--> statement-breakpoint
ALTER INDEX "attachments_item_idx" RENAME TO "attachments_record_idx";
--> statement-breakpoint
ALTER INDEX "clay_job_instance_idx" RENAME TO "clay_job_record_version_idx";
--> statement-breakpoint
ALTER INDEX "google_object_link_item_idx" RENAME TO "google_object_link_record_idx";
--> statement-breakpoint

-- ── FK constraints (also not auto-renamed) ─────────────────────────────────
ALTER TABLE "record_versions" RENAME CONSTRAINT "instances_concept_id_concepts_id_fk" TO "record_versions_concept_id_concepts_id_fk";
--> statement-breakpoint
ALTER TABLE "record_versions" RENAME CONSTRAINT "instances_item_id_items_id_fk" TO "record_versions_record_id_records_id_fk";
--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "items_concept_id_concepts_id_fk" TO "records_concept_id_concepts_id_fk";
--> statement-breakpoint
ALTER TABLE "relations" RENAME CONSTRAINT "relations_from_id_instances_id_fk" TO "relations_from_id_record_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "relations" RENAME CONSTRAINT "relations_to_item_id_items_id_fk" TO "relations_to_record_id_records_id_fk";
--> statement-breakpoint
ALTER TABLE "relations" RENAME CONSTRAINT "relations_to_version_id_instances_id_fk" TO "relations_to_version_id_record_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "relations" RENAME CONSTRAINT "relations_to_id_instances_id_fk" TO "relations_to_id_record_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "mentions" RENAME CONSTRAINT "mentions_from_instance_id_instances_id_fk" TO "mentions_from_version_id_record_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "mentions" RENAME CONSTRAINT "mentions_target_item_id_items_id_fk" TO "mentions_target_record_id_records_id_fk";
--> statement-breakpoint
ALTER TABLE "attachments" RENAME CONSTRAINT "attachments_item_id_items_id_fk" TO "attachments_record_id_records_id_fk";
--> statement-breakpoint

-- ── composite primary key ──────────────────────────────────────────────────
ALTER TABLE "record_graph_layouts" RENAME CONSTRAINT "instance_graph_layouts_org_id_item_id_pk" TO "record_graph_layouts_org_id_record_id_pk";
--> statement-breakpoint

-- ── data: subject_kind ──────────────────────────────────────────────────────
UPDATE "events" SET subject_kind = 'recordVersion' WHERE subject_kind = 'instance';
--> statement-breakpoint
UPDATE "events" SET subject_kind = 'record' WHERE subject_kind = 'item';
--> statement-breakpoint
UPDATE "annotations" SET subject_kind = 'record' WHERE subject_kind = 'item';
--> statement-breakpoint

-- ── data: event tags (event_type column AND payload._tag, in lockstep — the
--    event log is the source of truth `record_versions.state` is folded from,
--    so both must agree or replay corrupts) ─────────────────────────────────
UPDATE "events" SET event_type = 'RecordVersionCreated', payload = jsonb_set(payload, '{_tag}', '"RecordVersionCreated"') WHERE event_type = 'InstanceCreated';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordVersionUpdated', payload = jsonb_set(payload, '{_tag}', '"RecordVersionUpdated"') WHERE event_type = 'InstanceUpdated';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordVersionArchived', payload = jsonb_set(payload, '{_tag}', '"RecordVersionArchived"') WHERE event_type = 'InstanceArchived';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordVersionRestored', payload = jsonb_set(payload, '{_tag}', '"RecordVersionRestored"') WHERE event_type = 'InstanceRestored';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordVersionPurged', payload = jsonb_set(payload, '{_tag}', '"RecordVersionPurged"') WHERE event_type = 'InstancePurged';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordVersionDeleted', payload = jsonb_set(payload, '{_tag}', '"RecordVersionDeleted"') WHERE event_type = 'InstanceDeleted';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordArchived', payload = jsonb_set(payload, '{_tag}', '"RecordArchived"') WHERE event_type = 'ItemArchived';
--> statement-breakpoint
UPDATE "events" SET event_type = 'RecordRestored', payload = jsonb_set(payload, '{_tag}', '"RecordRestored"') WHERE event_type = 'ItemRestored';
--> statement-breakpoint

-- ── data: payload keys (only ever present on the two tags below — verified
--    zero other _tag ever used these key names) ───────────────────────────
UPDATE "events" SET payload = (payload - 'itemId') || jsonb_build_object('recordId', payload->'itemId') WHERE event_type = 'RecordVersionCreated' AND payload ? 'itemId';
--> statement-breakpoint
UPDATE "events" SET payload = (payload - 'toItemId') || jsonb_build_object('toRecordId', payload->'toItemId') WHERE event_type = 'RelationCreated' AND payload ? 'toItemId';
--> statement-breakpoint

-- ── data: dashboards.body jsonb ──────────────────────────────────────────
-- Best-effort for the flat legacy `body.widgets[]` shape. Does NOT recurse
-- into the newer nested-group tree (`body.children[]`) — arbitrary-depth
-- jsonb tree rewriting in pure SQL is a real correctness risk (a subtle
-- jsonb_set bug here silently corrupts a dashboard, which is worse than
-- leaving it alone). The client's `migrate()` normalizer
-- (app/src/lib/dashboards.ts) already handles BOTH shapes, recursively, and
-- is what every render path actually goes through — this is belt-and-braces
-- on top of that belt, not the sole mechanism. See the plan.
UPDATE "dashboards"
SET body = jsonb_set(
  body,
  '{widgets}',
  (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN w->>'type' = 'shortcuts' AND w ? 'items' THEN
            jsonb_set(
              w,
              '{items}',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE WHEN item->>'kind' = 'instance'
                      THEN jsonb_set(item, '{kind}', '"recordVersion"')
                      ELSE item
                    END
                    ORDER BY item_ord
                  )
                  FROM jsonb_array_elements(w->'items') WITH ORDINALITY AS ti(item, item_ord)
                ),
                w->'items'
              )
            )
          WHEN w->>'type' = 'welcome' AND w ? 'links' THEN
            jsonb_set(
              w,
              '{links}',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE WHEN item->>'kind' = 'instance'
                      THEN jsonb_set(item, '{kind}', '"recordVersion"')
                      ELSE item
                    END
                    ORDER BY item_ord
                  )
                  FROM jsonb_array_elements(w->'links') WITH ORDINALITY AS tl(item, item_ord)
                ),
                w->'links'
              )
            )
          WHEN w->>'type' = 'files' THEN
            (CASE WHEN w->>'scope' = 'instance' THEN jsonb_set(w, '{scope}', '"recordVersion"') ELSE w END)
            - 'instanceId'
            || CASE WHEN w ? 'instanceId' THEN jsonb_build_object('recordVersionId', w->'instanceId') ELSE '{}'::jsonb END
          WHEN w->>'type' = 'document' THEN
            (w - 'instanceId')
            || CASE WHEN w ? 'instanceId' THEN jsonb_build_object('recordVersionId', w->'instanceId') ELSE '{}'::jsonb END
          ELSE w
        END
        ORDER BY widget_ord
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(body->'widgets') WITH ORDINALITY AS tw(w, widget_ord)
  )
)
WHERE body ? 'widgets' AND jsonb_typeof(body->'widgets') = 'array';
--> statement-breakpoint

-- ── the debugging view, recreated under its new name with the new alias ───
CREATE VIEW "record_state_readable" AS
SELECT
  rv.id AS record_version_id,
  rv.org_id AS org_id,
  c.name AS concept_name,
  COALESCE(f.name, kv.key) AS field,
  kv.value AS value
FROM record_versions rv
JOIN concepts c ON c.id = rv.concept_id
CROSS JOIN LATERAL jsonb_each(rv.state) AS kv(key, value)
LEFT JOIN fields f
  ON f.org_id = rv.org_id
  AND f.id = (
    CASE WHEN kv.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN kv.key::uuid END
  )
WHERE rv.archived_at IS NULL;
