/**
 * One-off backfill: translate each concept's CUSTOMIZED instance_view tile layout
 * into a default RECORD DASHBOARD (the new single record-visualisation surface).
 *
 * Only concepts with a non-null `instance_view` are migrated — everything else
 * already renders the built-in fallback record layout, so there's nothing to
 * preserve. Idempotent: a concept that already has any record dashboard is
 * skipped. Managed concepts are skipped (they bypass to ManagedInstanceView).
 *
 * Dry-run by default (prints what it would do); pass `--apply` to write.
 *   bun app/scripts/migrate-record version-views.ts          # dry run
 *   bun app/scripts/migrate-record version-views.ts --apply  # write
 */
import { pool } from "../server/db"
import { tilesToBody, type ViewTileLike } from "../src/lib/recordDashboards"

const apply = process.argv.includes("--apply")

const concepts = await pool.query<{
  id: string
  org_id: string
  name: string
  versioning_enabled: boolean
  instance_view: { tiles?: ViewTileLike[] } | null
}>(
  `SELECT id, org_id, name, versioning_enabled, instance_view
     FROM concepts
    WHERE managed_by IS NULL AND instance_view IS NOT NULL`,
)

let migrated = 0
let skipped = 0
for (const c of concepts.rows) {
  const tiles = c.instance_view?.tiles ?? []
  if (tiles.length === 0) {
    skipped++
    continue
  }
  // Idempotent — never double-seed a concept's record dashboards.
  const existing = await pool.query(
    `SELECT 1 FROM dashboards WHERE org_id = $1 AND concept_id = $2 AND kind = 'record' LIMIT 1`,
    [c.org_id, c.id],
  )
  if ((existing.rowCount ?? 0) > 0) {
    console.log(`skip ${c.name} (${c.id}): already has a record dashboard`)
    skipped++
    continue
  }
  // The first rich text field (by order) — migrated `document` tiles bind to it.
  const fields = await pool.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM fields
       WHERE concept_id = $1 AND archived_at IS NULL
       ORDER BY position ASC, name ASC`,
    [c.id],
  )
  const richtext = fields.rows.find((f) => f.kind === "richtext")
  const body = tilesToBody(tiles, {
    versioned: c.versioning_enabled,
    hasDocuments: !!richtext,
    richtextFieldId: richtext?.id ?? null,
    conceptId: c.id,
  })
  if (!body) {
    console.log(`skip ${c.name} (${c.id}): no migratable contents`)
    skipped++
    continue
  }
  console.log(
    `${apply ? "migrate" : "[dry] would migrate"} ${c.name} (${c.id}): ${tiles.length} tile(s) → ${
      body.children?.length ?? 0
    } row(s)`,
  )
  if (apply) {
    await pool.query(
      `INSERT INTO dashboards (org_id, owner_id, name, kind, concept_id, is_default, position, body)
       VALUES ($1, NULL, $2, 'record', $3, true, 0, $4::jsonb)`,
      [c.org_id, `${c.name} view`, c.id, JSON.stringify(body)],
    )
  }
  migrated++
}

console.log(
  `\n${apply ? "Migrated" : "[dry-run] Would migrate"} ${migrated} concept(s); skipped ${skipped}.`,
)
await pool.end()
