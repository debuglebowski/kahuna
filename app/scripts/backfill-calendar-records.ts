/**
 * One-off backfill: project already-synced Google Calendar events from the raw
 * `google_calendar_event` table into their managed concept's record versions. Needed
 * because the concept projection was added after the initial full sync banked a
 * syncToken, so the historical events were never re-fetched/projected. Mirrors
 * `mirrorCalendarEvents` (server/google.ts) but runs standalone (no Google API).
 * Idempotent — keyed by event id; safe to re-run and safe alongside a UI "Sync".
 */
import { pool } from "../server/db"
import { upsertRecordVersionByExternalId } from "../server/integrations/records"
import { systemScope } from "../server/runtime"

type RawEvent = {
  id?: string
  summary?: string
  location?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

const fieldsFor = (raw: RawEvent, fm: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    const id = fm[key]
    if (id && value !== undefined && value !== null && value !== "") out[id] = value
  }
  set("externalId", raw.id)
  set("title", raw.summary)
  set("startsAt", raw.start?.dateTime ?? raw.start?.date)
  set("endsAt", raw.end?.dateTime ?? raw.end?.date)
  set("location", raw.location)
  return out
}

const conns = await pool.query<{
  id: string
  org_id: string
  user_id: string
  concept_id: string
  field_map: Record<string, string>
}>(`SELECT id, org_id, user_id, concept_id, field_map FROM google_connection
     WHERE concept_id IS NOT NULL AND field_map IS NOT NULL`)

for (const c of conns.rows) {
  const fm = c.field_map
  const externalFieldId = fm.externalId
  if (!externalFieldId) {
    console.log(`conn ${c.id}: no externalId in field_map, skipping`)
    continue
  }
  const events = await pool.query<{ google_event_id: string; raw: RawEvent }>(
    `SELECT google_event_id, raw FROM google_calendar_event
       WHERE connection_id = $1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled'`,
    [c.id],
  )
  const live = await pool.query<{ ext: string; state: Record<string, unknown> }>(
    `SELECT state->>$2 AS ext, state FROM recordVersions
       WHERE org_id = $1 AND concept_id = $3 AND archived_at IS NULL AND version_status = 'published'`,
    [c.org_id, externalFieldId, c.concept_id],
  )
  const stateByExt = new Map(live.rows.map((r) => [r.ext, r.state]))
  let created = 0
  let updated = 0
  let skipped = 0
  for (const row of events.rows) {
    if (!row.google_event_id) continue
    const fields = fieldsFor(row.raw, fm)
    const current = stateByExt.get(row.google_event_id)
    if (current && Object.entries(fields).every(([k, v]) => current[k] === v)) {
      skipped++
      continue
    }
    const res = await upsertRecordVersionByExternalId(systemScope(c.org_id, c.user_id), {
      conceptId: c.concept_id,
      externalFieldId,
      externalValue: row.google_event_id,
      fields,
    })
    if (res.created) created++
    else updated++
    if ((created + updated) % 500 === 0) console.log(`  ...${created + updated} projected`)
  }
  console.log(
    `conn ${c.id}: ${events.rows.length} events → created ${created}, updated ${updated}, skipped ${skipped}`,
  )
}

await pool.end()
console.log("backfill done")
process.exit(0)
