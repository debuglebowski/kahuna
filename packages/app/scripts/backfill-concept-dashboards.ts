/**
 * One-off backfill for the "every concept = a dashboard" model:
 *  1. Each live concept gets an ordinary org dashboard (name/icon from the
 *     concept, body = its table as one full-width list widget) — skipped when a
 *     dashboard with that name already exists in the org.
 *  2. Sidebar view bodies are rewritten: pinned `concept` members become
 *     `dashboard` members (via the concept→dashboard mapping) and `concepts`
 *     rules become the `dashboards` rule.
 * Idempotent: re-running creates nothing new and leaves rewritten bodies alone.
 *
 * Run: bun scripts/backfill-concept-dashboards.ts
 */
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kahuna:kahuna@localhost:5544/kahuna"
const pool = new Pool({ connectionString })

const seedBody = (conceptId: string) => ({
  widgets: [
    {
      id: crypto.randomUUID(),
      type: "list",
      title: null,
      layout: { x: 0, y: 0, w: 12, h: 7 },
      conceptId,
      conditions: [],
      orderBy: null,
      limit: null,
    },
  ],
})

const main = async () => {
  const concepts = await pool.query<{
    id: string
    org_id: string
    name: string
    icon: string | null
  }>("SELECT id, org_id, name, icon FROM concepts WHERE archived_at IS NULL ORDER BY created_at")

  // concept id -> dashboard id (existing by name, else freshly created)
  const dashFor = new Map<string, string>()
  let created = 0
  for (const c of concepts.rows) {
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM dashboards WHERE org_id = $1 AND name = $2 LIMIT 1",
      [c.org_id, c.name],
    )
    if (existing.rows[0]) {
      dashFor.set(c.id, existing.rows[0].id)
      continue
    }
    const pos = await pool.query<{ max: number | null }>(
      "SELECT MAX(position)::int AS max FROM dashboards WHERE org_id = $1",
      [c.org_id],
    )
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, name, icon, position, body)
       VALUES ($1, NULL, $2, $3, $4, $5::jsonb) RETURNING id`,
      [c.org_id, c.name, c.icon, (pos.rows[0]?.max ?? -1) + 1, JSON.stringify(seedBody(c.id))],
    )
    dashFor.set(c.id, inserted.rows[0]!.id)
    created++
  }

  // Rewrite sidebar bodies: concept members -> dashboard members, concepts rule
  // -> dashboards rule. Unknown/dangling concept pins are dropped.
  const views = await pool.query<{ id: string; body: unknown }>(
    "SELECT id, body FROM sidebar_views",
  )
  let rewritten = 0
  for (const v of views.rows) {
    const body = v.body as { sections?: unknown[] }
    if (!Array.isArray(body?.sections)) continue
    let changed = false
    const sections = body.sections.map((s) => {
      const sec = s as { source?: { kind?: string; members?: unknown[]; rules?: unknown[] } }
      const src = sec.source
      if (src?.kind !== "group") return s
      const members = (src.members ?? []).flatMap((m) => {
        const mm = m as { kind?: string; conceptId?: string }
        if (mm.kind !== "concept") return [m]
        changed = true
        const dashboardId = mm.conceptId ? dashFor.get(mm.conceptId) : undefined
        return dashboardId ? [{ kind: "dashboard", dashboardId }] : []
      })
      const rules = (src.rules ?? []).map((r) => {
        const rr = r as { target?: string }
        if (rr.target !== "concepts") return r
        changed = true
        return { target: "dashboards" }
      })
      return { ...sec, source: { ...src, members, rules } }
    })
    if (!changed) continue
    await pool.query(
      "UPDATE sidebar_views SET body = $1::jsonb, updated_at = now() WHERE id = $2",
      [JSON.stringify({ ...body, sections }), v.id],
    )
    rewritten++
  }

  console.log(
    `concepts: ${concepts.rows.length}, dashboards created: ${created}, sidebar views rewritten: ${rewritten}`,
  )
  await pool.end()
}

await main()
