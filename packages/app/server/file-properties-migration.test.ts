import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { AttachmentService, ConceptService, FieldService, RecordService } from "#engine"
import { pool } from "./db"
import { runEngineOrThrow, systemScope } from "./runtime"

/**
 * Migration 0028's data half: a file field's value stored in `state` (only
 * reachable by bypassing the engine — it always refused such writes) is turned
 * into a linked attachment when it names one on the same record, and the stray
 * key is dropped either way. The schema half is already applied to the test DB,
 * so only the two UPDATE statements of the real file are run here.
 */

const MIGRATION = path.resolve(import.meta.dirname, "../db/migrations/0028_file_properties.sql")

const runDataMigration = async () => {
  for (const stmt of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    if (/^\s*UPDATE /m.test(stmt)) await pool.query(stmt)
  }
}

const setState = (versionId: string, key: string, value: unknown) =>
  pool.query(
    `UPDATE record_versions SET state = jsonb_set(state, $2::text[], $3::jsonb) WHERE id = $1`,
    [versionId, [key], JSON.stringify(value)],
  )

describe("migration 0028 — existing single-file values", () => {
  it("links a stored attachment id to the property, drops stray keys, leaves others alone", async () => {
    const orgId = randomUUID()
    const scope = systemScope(orgId, "seed")
    const s = await runEngineOrThrow(
      scope,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const records = yield* RecordService
        const att = yield* AttachmentService
        const c = yield* concepts.create({ name: "Agreement" })
        const title = yield* fields.addField({ conceptId: c.id, name: "Title", kind: "text" })
        const doc = yield* fields.addField({ conceptId: c.id, name: "Contract", kind: "file" })
        const r1 = yield* records.create({ conceptId: c.id, fields: { [title.id]: "one" } })
        const r2 = yield* records.create({ conceptId: c.id, fields: { [title.id]: "two" } })
        const up = (recordId: string) =>
          att.upload({ owner: { recordId }, filename: "c.pdf", data: new Uint8Array([1]) })
        const a1 = yield* up(r1.recordId)
        // A file on ANOTHER record: r2's stored value names it, but must not steal it.
        const other = yield* up(r1.recordId)
        return { c, title, doc, r1, r2, a1, other }
      }),
    )
    await setState(s.r1.id, s.doc.id, s.a1.id)
    await setState(s.r2.id, s.doc.id, { id: s.other.id })

    await runDataMigration()

    const rows = await pool.query<{ id: string; field_id: string | null }>(
      "SELECT id, field_id FROM attachments WHERE id = ANY($1)",
      [[s.a1.id, s.other.id]],
    )
    const fieldOf = new Map(rows.rows.map((r) => [r.id, r.field_id]))
    expect(fieldOf.get(s.a1.id)).toBe(s.doc.id)
    expect(fieldOf.get(s.other.id)).toBeNull()

    const states = await pool.query<{ id: string; state: Record<string, unknown> }>(
      "SELECT id, state FROM record_versions WHERE id = ANY($1)",
      [[s.r1.id, s.r2.id]],
    )
    for (const r of states.rows) {
      expect(r.state).not.toHaveProperty(s.doc.id)
      expect(r.state).toHaveProperty(s.title.id)
    }

    // Idempotent: a second run changes nothing.
    await runDataMigration()
    const again = await pool.query<{ field_id: string | null }>(
      "SELECT field_id FROM attachments WHERE id = $1",
      [s.a1.id],
    )
    expect(again.rows[0]?.field_id).toBe(s.doc.id)
  })
})
