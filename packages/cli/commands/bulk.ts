import { readFileSync } from "node:fs"
import type { Concept, Field, RecordVersion } from "@kahunalabs/contract"
import { requireSession } from "../config.ts"
import { csvToObjects } from "../csv.ts"
import { CliError, EXIT } from "../errors.ts"
import { withVersion } from "../mutate.ts"
import { note, printRows, renderCsv } from "../output.ts"
import type { Command } from "../registry.ts"
import {
  type CoerceOptions,
  coerceValue,
  conceptContext,
  fetchDefaultCurrency,
  findConcept,
  findField,
  labelOf,
} from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

/**
 * Export uses FIELD NAMES as columns, not ids.
 *
 * A UUID-keyed export is unreadable and — worse — un-editable: the point of
 * exporting to CSV is that someone opens it, changes a value and imports it
 * back. Names round-trip through `record import`, ids do not survive a rename.
 */
const exportRows = async (
  api: Api,
  concept: Concept,
  fields: ReadonlyArray<Field>,
  includeArchived: boolean,
): Promise<{ columns: ReadonlyArray<string>; rows: ReadonlyArray<Record<string, unknown>> }> => {
  const versions = await api.call((c) => c.listRecords({ conceptId: concept.id, includeArchived }))

  // Relations are resolved to the target's LABEL, one lookup per target concept
  // rather than per row — a fan-out per row would be thousands of calls.
  const relationFields = fields.filter((f) => f.kind === "relation" && f.config.target)
  const labelsByRecord = new Map<string, string>()
  for (const rel of relationFields) {
    const targetId = rel.config.target
    if (!targetId) continue
    const picks = await api
      .call((c) => c.searchRecords({ conceptId: targetId, limit: 50_000 }))
      .catch(() => [])
    for (const p of picks) labelsByRecord.set(p.recordId, p.label)
  }

  const columns = ["id", ...fields.map((f) => f.name)]
  const rows = versions.map((v: RecordVersion) => {
    const row: Record<string, unknown> = { id: v.id }
    for (const f of fields) {
      const raw = v.state[f.id]
      if (f.kind === "relation" && typeof raw === "string") {
        row[f.name] = labelsByRecord.get(raw) ?? raw
      } else if (Array.isArray(raw)) {
        row[f.name] = raw.join("; ")
      } else {
        row[f.name] = raw
      }
    }
    return row
  })
  return { columns, rows }
}

export const bulkCommands: ReadonlyArray<Command> = [
  {
    path: "record export",
    summary: "Export a concept's records as CSV or JSON",
    usage: "record export <concept> [--csv|--json] [--all-concepts] [--archived] [--out <file>]",
    options: {
      "all-concepts": { type: "boolean" },
      archived: { type: "boolean" },
      out: { type: "string" },
    },
    run: async (ctx) => {
      const [conceptName] = ctx.args
      const all = Boolean(ctx.flags["all-concepts"])
      if (!conceptName && !all) {
        throw new CliError("Which concept? (or pass --all-concepts)", EXIT.usage)
      }
      await withApi(async (api) => {
        const concepts = await api.call((c) => c.listConcepts({}))
        const targets = all ? concepts : [findConcept(concepts, conceptName as string)]

        if (all && ctx.format !== "json") {
          // One CSV cannot hold several concepts' columns without inventing a
          // shape nobody asked for. Say so instead of emitting a mess.
          throw new CliError(
            "--all-concepts needs --json.",
            EXIT.usage,
            "Concepts have different columns, so they cannot share one CSV. Export them one at a time for CSV.",
          )
        }

        const bundles: Record<string, unknown> = {}
        for (const concept of targets) {
          const fields = await api.call((c) => c.listFields({ conceptId: concept.id }))
          const { columns, rows } = await exportRows(
            api,
            concept,
            fields,
            Boolean(ctx.flags.archived),
          )
          if (all) {
            bundles[concept.slug] = rows
            continue
          }
          const out = ctx.flags.out as string | undefined
          const text =
            ctx.format === "json" ? JSON.stringify(rows, null, 2) : renderCsv(rows, columns)
          if (out) {
            const { writeFileSync } = await import("node:fs")
            writeFileSync(out, `${text}\n`)
            note(`Wrote ${rows.length} rows to ${out}.`)
          } else {
            process.stdout.write(`${text}\n`)
          }
        }
        if (all) {
          const text = JSON.stringify(bundles, null, 2)
          const out = ctx.flags.out as string | undefined
          if (out) {
            const { writeFileSync } = await import("node:fs")
            writeFileSync(out, `${text}\n`)
            note(`Wrote ${targets.length} concepts to ${out}.`)
          } else {
            process.stdout.write(`${text}\n`)
          }
        }
      })
    },
  },
  {
    path: "record import",
    summary: "Create or update records from a CSV or JSON file",
    usage: "record import <concept> <file> [--key <field>] [--dry-run]",
    options: { key: { type: "string" } },
    run: async (ctx) => {
      const [conceptName, file] = ctx.args
      if (!conceptName || !file) throw new CliError("Need <concept> <file>.", EXIT.usage)

      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        throw new CliError(`Cannot read ${file}.`, EXIT.notFound)
      }

      const parsed: ReadonlyArray<Record<string, unknown>> = file.endsWith(".json")
        ? (JSON.parse(text) as ReadonlyArray<Record<string, unknown>>)
        : csvToObjects(text)
      if (!Array.isArray(parsed)) {
        throw new CliError("Expected a JSON array of objects.", EXIT.usage)
      }
      if (parsed.length === 0) {
        note("Nothing to import — the file has no rows.")
        return
      }

      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, conceptName)

        // Columns the concept does not have are a FAILURE, not something to
        // skip: a typo'd header would otherwise import every row with that
        // column silently missing, which looks like success.
        const headers = Object.keys(parsed[0] ?? {}).filter((h) => h !== "id")
        const byHeader = new Map<string, Field>()
        const unknown: string[] = []
        for (const h of headers) {
          const field = fields.find((f) => f.name.toLowerCase() === h.trim().toLowerCase())
          if (field) byHeader.set(h, field)
          else unknown.push(h)
        }
        if (unknown.length > 0) {
          throw new CliError(
            `${concept.name} has no field named ${unknown.map((u) => `"${u}"`).join(", ")}.`,
            EXIT.notFound,
            `Columns available: ${fields.map((f) => f.name).join(", ")}`,
          )
        }

        // --key makes the import idempotent: rows matching an existing record on
        // that field are updated instead of duplicated. Without it, every run
        // creates new records, which is right for a one-off load and wrong for
        // anything re-run.
        const keyField = ctx.flags.key ? findField(fields, ctx.flags.key as string) : undefined
        const existing = keyField
          ? await api.call((c) => c.listRecords({ conceptId: concept.id }))
          : []
        const byKey = new Map<string, RecordVersion>()
        for (const v of existing) {
          const k = v.state[keyField?.id ?? ""]
          if (typeof k === "string") byKey.set(k.toLowerCase(), v)
        }

        // Coerce EVERY row before writing ANY: a bad cell on row 900 must not
        // leave 899 rows imported and the rest not. Same coercion as `--field`.
        const needsCurrency = [...byHeader.values()].some((f) => f.kind === "money")
        const options: CoerceOptions = {
          defaultCurrency: needsCurrency ? await fetchDefaultCurrency(api) : undefined,
        }
        const rowValues: Array<Record<string, unknown>> = []
        const invalid: Array<{ row: number; error: string }> = []
        for (const [index, raw] of parsed.entries()) {
          const values: Record<string, unknown> = {}
          try {
            for (const [header, field] of byHeader) {
              const cell = raw[header]
              if (cell === undefined) continue
              values[field.id] = coerceCell(field, cell, options)
            }
          } catch (e) {
            invalid.push({ row: index + 2, error: e instanceof Error ? e.message : String(e) })
          }
          rowValues.push(values)
        }
        if (invalid.length > 0) {
          printRows("table", invalid)
          throw new CliError(
            `${invalid.length} row(s) have invalid values; nothing was imported.`,
            EXIT.usage,
            "Row numbers count the header as line 1.",
          )
        }

        let created = 0
        let updated = 0
        const failures: Array<{ row: number; error: string }> = []

        for (const [index, raw] of parsed.entries()) {
          const values = rowValues[index] ?? {}

          const keyValue = keyField ? String(raw[keyField.name] ?? "").toLowerCase() : ""
          const match = keyField && keyValue ? byKey.get(keyValue) : undefined

          if (ctx.flags["dry-run"]) {
            if (match) updated++
            else created++
            continue
          }

          try {
            if (match) {
              await withVersion(
                async () => (await api.call((c) => c.getRecord({ id: match.id }))).recordVersion,
                (current) =>
                  api.call((c) =>
                    c.updateRecord({
                      id: match.id,
                      expectedVersion: current.version,
                      patch: values,
                    }),
                  ),
              )
              updated++
            } else {
              await api.call((c) => c.createRecord({ conceptId: concept.id, fields: values }))
              created++
            }
          } catch (e) {
            // Keep going and report at the end. Aborting halfway through a
            // thousand-row import leaves the caller with no idea which rows
            // landed; a per-row report tells them exactly what to fix and retry.
            const err = e as { code?: string; message?: string }
            failures.push({ row: index + 2, error: err.code ?? err.message ?? String(e) })
          }
        }

        const verb = ctx.flags["dry-run"] ? "Would import" : "Imported"
        note(`${verb}: ${created} created, ${updated} updated, ${failures.length} failed.`)
        if (failures.length > 0) {
          printRows("table", failures)
          throw new CliError(
            `${failures.length} row(s) failed.`,
            EXIT.failed,
            "Row numbers count the header as line 1.",
          )
        }
      })
    },
  },
]

/**
 * Same coercion as `--field name=value`, from a cell rather than an argument —
 * except `@path` is NOT expanded: a cell is data, and a CSV must not be able to
 * make the importer read arbitrary local files. A JSON import's structured cell
 * (an object for money/richtext/json) is sent through the same parser as its
 * JSON text, so it is validated, not trusted.
 */
const coerceCell = (field: Field, cell: unknown, options: CoerceOptions): unknown => {
  if (cell === null || cell === "") return null
  const text = typeof cell === "object" ? JSON.stringify(cell) : String(cell)
  return coerceValue(field, text, options)
}

/** Re-exported so `record export` can label rows the way `record list` does. */
export { labelOf }
