-- Gmail is disabled (docs/google-integration.md). Remove the mail the old mirror
-- already copied. Everything here is derived from a mailbox and can be re-created by
-- a sync, so none of it is business data. Idempotent: a second run finds nothing.
--
-- Not a purge of the Email records. A hard delete has a wide dependent graph
-- (relations, mentions, attachments, annotations) and a missed row would fail the
-- migration and block boot. The records are instead blanked of the connector-owned
-- fields and archived, which removes every personal value and releases the unique
-- external-id values without touching any dependent row. User-added fields on that
-- concept are left as they were.

-- 1. Mirror rows, sync cursors and record links. Bodies, snippets and the raw API
--    responses live in these tables.
DELETE FROM "google_gmail_message";--> statement-breakpoint
DELETE FROM "google_gmail_thread";--> statement-breakpoint
DELETE FROM "google_gmail_sync";--> statement-breakpoint
DELETE FROM "google_object_link" WHERE "provider_kind" = 'gmail_thread';--> statement-breakpoint

-- 2. The event log. Record purge keeps events by design, so subject and sender sit in
--    the payloads of every create/update, including those of records since purged.
--    A record version is an Email one if its create event names a Gmail-managed
--    concept; that also finds versions whose row is gone. Only the connector-owned
--    field keys are removed from `fields` / `patch`; the rows and ids stay.
UPDATE "events" e
SET "payload" = CASE
  WHEN jsonb_typeof(e."payload"->'fields') = 'object'
    THEN jsonb_set(e."payload", '{fields}', (e."payload"->'fields') - k."keys")
  ELSE jsonb_set(e."payload", '{patch}', (e."payload"->'patch') - k."keys")
END
FROM (
  SELECT array_agg(f."id"::text) AS "keys"
  FROM "fields" f
  JOIN "concepts" c ON c."id" = f."concept_id"
  WHERE c."managed_by" = 'google.gmail' AND f."managed_by" = 'google.gmail'
) k
WHERE k."keys" IS NOT NULL
  AND e."subject_kind" = 'recordVersion'
  AND (jsonb_typeof(e."payload"->'fields') = 'object' OR jsonb_typeof(e."payload"->'patch') = 'object')
  AND e."subject_id" IN (
    SELECT created."subject_id"
    FROM "events" created
    WHERE created."subject_kind" = 'recordVersion'
      AND created."event_type" = 'RecordVersionCreated'
      AND created."payload"->>'conceptId' IN (
        SELECT "id"::text FROM "concepts" WHERE "managed_by" = 'google.gmail'
      )
  );--> statement-breakpoint

-- 3. The records themselves: drop the connector-owned values, then archive.
UPDATE "record_versions" rv
SET "state" = rv."state" - k."keys",
    "archived_at" = COALESCE(rv."archived_at", now())
FROM (
  SELECT array_agg(f."id"::text) AS "keys"
  FROM "fields" f
  JOIN "concepts" c ON c."id" = f."concept_id"
  WHERE c."managed_by" = 'google.gmail' AND f."managed_by" = 'google.gmail'
) k
WHERE k."keys" IS NOT NULL
  AND rv."concept_id" IN (SELECT "id" FROM "concepts" WHERE "managed_by" = 'google.gmail');--> statement-breakpoint
UPDATE "records"
SET "archived_at" = COALESCE("archived_at", now())
WHERE "concept_id" IN (SELECT "id" FROM "concepts" WHERE "managed_by" = 'google.gmail');
