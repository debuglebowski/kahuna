import type { Concept, Field, RecordVersion } from "@alltinghq/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation, withVersion } from "../mutate.ts"
import type { Format, Row } from "../output.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command, CommandContext } from "../registry.ts"
import { conceptContext, labelOf, parseFieldAssignments } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

/** Open a client for this invocation and always dispose it. */
const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const asArray = (v: unknown): ReadonlyArray<string> =>
  v === undefined ? [] : Array.isArray(v) ? (v as string[]) : [String(v)]

/**
 * The columns a concept's rows have, in a stable order.
 *
 * Derived from the CONCEPT, not from the rows: inferring columns from data
 * means an empty result has no columns, so `--csv` emits nothing at all and a
 * consumer cannot tell "no matches" from "broken pipe". It also means two runs
 * can disagree on column order when some rows omit a field.
 */
const columnsFor = (concept: Concept, fields: ReadonlyArray<Field>): ReadonlyArray<string> => [
  "id",
  "record",
  "label",
  ...(concept.versioningEnabled ? ["version", "status"] : []),
  ...fields.map((f) => f.name),
]

/** A record version as a flat row: ids, status, then one column per field. */
const toRow = (version: RecordVersion, concept: Concept, fields: ReadonlyArray<Field>): Row => {
  const row: Row = {
    id: version.id,
    // BOTH ids, always. `id` addresses this VERSION; `record` addresses the
    // lineage — and the lineage is what tasks, notes and attachments attach to
    // (`subjectId`, `listFiles.recordId`, the upload route). Printing only the
    // version id left no way to reach any of them from the shell.
    record: version.recordId,
    label: labelOf(version, concept, fields),
  }
  if (concept.versioningEnabled) {
    row.version = version.versionSeq
    row.status = version.versionStatus
  }
  for (const f of fields) row[f.name] = version.state[f.id]
  if (version.archivedAt) row.archived = true
  return row
}

/**
 * Client-side filtering, because the API has none.
 *
 * `listRecords` takes `{conceptId, includeArchived}` and nothing else — no
 * filter, sort, limit, offset or cursor exists anywhere in the contract. So
 * `--where` and `--sort` happen here, over the whole set, and the server's
 * 50 000-row cap is the real ceiling. Say so on stderr when we hit it rather
 * than quietly returning a truncated list that looks complete.
 */
const LIST_CAP = 50_000

const applyWhere = (
  rows: ReadonlyArray<RecordVersion>,
  fields: ReadonlyArray<Field>,
  clauses: ReadonlyArray<string>,
): ReadonlyArray<RecordVersion> => {
  let out = rows
  for (const clause of clauses) {
    const eq = clause.indexOf("=")
    if (eq === -1) throw new CliError(`Expected field=value, got "${clause}".`, EXIT.usage)
    const name = clause.slice(0, eq)
    const want = clause.slice(eq + 1).toLowerCase()
    const field = fields.find((f) => f.name.toLowerCase() === name.toLowerCase() || f.id === name)
    if (!field) throw new CliError(`No field named "${name}".`, EXIT.notFound)
    out = out.filter((r) => {
      const v = r.state[field.id]
      return (v === null || v === undefined ? "" : String(v)).toLowerCase() === want
    })
  }
  return out
}

export const recordCommands: ReadonlyArray<Command> = [
  {
    path: "record list",
    summary: "List a concept's records",
    usage: "record list <concept> [--where field=value] [--sort field] [--limit n] [--archived]",
    options: {
      where: { type: "string", multiple: true },
      sort: { type: "string" },
      limit: { type: "string" },
      archived: { type: "boolean" },
    },
    run: async (ctx) => {
      const [conceptName] = ctx.args
      if (!conceptName) throw new CliError("Which concept?", EXIT.usage)
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, conceptName)
        const all = await api.call((c) =>
          c.listRecords({
            conceptId: concept.id,
            includeArchived: Boolean(ctx.flags.archived),
          }),
        )
        if (all.length >= LIST_CAP) {
          note(
            `Warning: the server returned ${all.length} records, its maximum. Some may be missing —` +
              " the API has no pagination, so this is a hard ceiling, not a page.",
          )
        }

        let rows = applyWhere(all, fields, asArray(ctx.flags.where))
        const sort = ctx.flags.sort as string | undefined
        if (sort) {
          const field = fields.find((f) => f.name.toLowerCase() === sort.toLowerCase())
          if (!field) throw new CliError(`No field named "${sort}".`, EXIT.notFound)
          rows = [...rows].sort((a, b) =>
            String(a.state[field.id] ?? "").localeCompare(String(b.state[field.id] ?? "")),
          )
        }
        const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new CliError("--limit needs a number.", EXIT.usage)
        }
        const shown = limit ? rows.slice(0, limit) : rows
        printRows(
          ctx.format,
          shown.map((r) => toRow(r, concept, fields)),
          columnsFor(concept, fields),
        )
      })
    },
  },
  {
    path: "record get",
    summary: "Show one record",
    usage: "record get <id | concept-slug-for-single-record>",
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which record?", EXIT.usage)
      await withApi(async (api) => {
        const detail = await getDetail(api, target)
        const row = toRow(detail.recordVersion, detail.concept, detail.fields)
        if (detail.labels.length > 0) row.labels = detail.labels.map((l) => l.name).join(", ")
        printOne(ctx.format, row)
      })
    },
  },
  {
    path: "record create",
    summary: "Create a record",
    usage: "record create <concept> --field name=value [--field ...]",
    options: { field: { type: "string", multiple: true, short: "f" } },
    run: async (ctx) => {
      const [conceptName] = ctx.args
      if (!conceptName) throw new CliError("Which concept?", EXIT.usage)
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, conceptName)
        const values = parseFieldAssignments(fields, asArray(ctx.flags.field))
        if (ctx.flags["dry-run"]) {
          note(`Would create a ${concept.name} with ${Object.keys(values).length} field(s).`)
          return
        }
        const created = await api.call((c) =>
          c.createRecord({ conceptId: concept.id, fields: values }),
        )
        emit(ctx.format, created, concept, fields, "Created")
      })
    },
  },
  {
    path: "record update",
    summary: "Patch fields on a record",
    usage: "record update <id> --field name=value [--field ...]",
    options: { field: { type: "string", multiple: true, short: "f" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(async (api) => {
        const detail = await getDetail(api, id)
        const patch = parseFieldAssignments(detail.fields, asArray(ctx.flags.field))
        if (Object.keys(patch).length === 0) throw new CliError("Nothing to change.", EXIT.usage)
        if (ctx.flags["dry-run"]) {
          note(`Would patch ${Object.keys(patch).length} field(s) on ${id}.`)
          return
        }
        // Read-then-write: the API needs the version we are basing the edit on.
        const updated = await withVersion(
          async () => (await api.call((c) => c.getRecord({ id }))).recordVersion,
          (current) =>
            api.call((c) => c.updateRecord({ id, expectedVersion: current.version, patch })),
        )
        emit(ctx.format, updated, detail.concept, detail.fields, "Updated")
      })
    },
  },
  {
    path: "record transition",
    summary: "Move an enum field along its allowed transitions",
    usage: "record transition <id> --field <name> --to <value>",
    options: { field: { type: "string" }, to: { type: "string" } },
    run: async (ctx) => {
      const [id] = ctx.args
      const fieldName = ctx.flags.field as string | undefined
      const to = ctx.flags.to as string | undefined
      if (!id || !fieldName || !to)
        throw new CliError("Need <id> --field <name> --to <value>.", EXIT.usage)
      await withApi(async (api) => {
        const detail = await getDetail(api, id)
        const field = detail.fields.find(
          (f) => f.name.toLowerCase() === fieldName.toLowerCase() || f.id === fieldName,
        )
        if (!field) throw new CliError(`No field named "${fieldName}".`, EXIT.notFound)
        if (ctx.flags["dry-run"]) {
          note(`Would move "${field.name}" to "${to}" on ${id}.`)
          return
        }
        const moved = await withVersion(
          async () => (await api.call((c) => c.getRecord({ id }))).recordVersion,
          (current) =>
            api.call((c) =>
              c.transitionRecord({
                id,
                expectedVersion: current.version,
                field: field.id,
                to,
              }),
            ),
        )
        emit(ctx.format, moved, detail.concept, detail.fields, "Moved")
      })
    },
  },
  {
    path: "record archive",
    summary: "Archive a record, or one version with --version",
    usage: "record archive <id> [--version]",
    options: { version: { type: "boolean" } },
    run: async (ctx) => archiveOrRestore(ctx, "archive"),
  },
  {
    path: "record restore",
    summary: "Restore an archived record, or one version with --version",
    usage: "record restore <id> [--version]",
    options: { version: { type: "boolean" } },
    run: async (ctx) => archiveOrRestore(ctx, "restore"),
  },
  {
    path: "record delete",
    summary: "PURGE a record version permanently",
    usage: "record delete <id> --yes",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete ${id}`)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would PURGE record version ${id}. This cannot be undone.`)
          return
        }
        await api.call((c) => c.deleteRecordVersion({ id }))
        note(`Purged ${id}.`)
      })
    },
  },
  {
    path: "record search",
    summary: "Search records inside one concept",
    usage: "record search <concept> <query> [--limit n]",
    options: { limit: { type: "string" } },
    run: async (ctx) => {
      const [conceptName, ...rest] = ctx.args
      const query = rest.join(" ")
      if (!conceptName || !query) throw new CliError("Need <concept> <query>.", EXIT.usage)
      await withApi(async (api) => {
        const { concept } = await conceptContext(api, conceptName)
        // searchRecords REQUIRES a conceptId and returns picks (label + ids),
        // not full records — cross-concept search would be a fan-out.
        const picks = await api.call((c) =>
          c.searchRecords({
            conceptId: concept.id,
            query,
            limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
          }),
        )
        printRows(
          ctx.format,
          picks.map((p) => ({
            id: p.recordVersionId,
            record: p.recordId,
            label: p.label,
            version: p.versionSeq,
            status: p.versionStatus,
          })),
        )
      })
    },
  },
  {
    path: "record changed",
    summary: "The recent-changes feed",
    usage: "record changed [--json]",
    run: async (ctx) => {
      await withApi(async (api) => {
        // `getChanged` takes NO payload — there is no `--since` to pass. A
        // windowed view is `record event list --since`.
        const feed = await api.call((c) => c.getChanged())
        printRows(
          ctx.format,
          feed.map((f) => ({ ...(f as unknown as Row) })),
        )
      })
    },
  },
  {
    path: "record open",
    summary: "Print the web URL for a record",
    usage: "record open <id> [--print]",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      const session = requireSession()
      // `/records/:id` — see App.tsx. Printed rather than launched: a CLI that
      // opens a browser without being asked is a surprise in an ssh session.
      process.stdout.write(`${session.host}/records/${id}\n`)
    },
  },
]

/** Fetch a record by id, or a single-record concept by slug. */
const getDetail = async (api: Api, target: string) => {
  try {
    return await api.call((c) => c.getRecord({ id: target }))
  } catch (e) {
    // Not an id — try it as the slug of a single-record concept, which is the
    // other thing a user can reasonably type here.
    const concepts = await api.call((c) => c.listConcepts({})).catch(() => [])
    const single = concepts.find(
      (c) => c.singleRecord && c.slug.toLowerCase() === target.toLowerCase(),
    )
    if (!single) throw e
    const detail = await api.call((c) => c.getSingleRecord({ conceptId: single.id }))
    if (!detail) throw new CliError(`"${target}" has no record yet.`, EXIT.notFound)
    return detail
  }
}

const emit = (
  format: Format,
  version: RecordVersion,
  concept: Concept,
  fields: ReadonlyArray<Field>,
  verb: string,
): void => {
  if (format === "json") {
    printOne(format, toRow(version, concept, fields))
    return
  }
  note(`${verb} ${labelOf(version, concept, fields)} (${version.id}).`)
}

const archiveOrRestore = async (
  ctx: CommandContext,
  verb: "archive" | "restore",
): Promise<void> => {
  const [id] = ctx.args
  if (!id) throw new CliError("Which record?", EXIT.usage)
  const oneVersion = Boolean(ctx.flags.version)
  await withApi(async (api) => {
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} ${oneVersion ? "version" : "the whole record"} ${id}.`)
      return
    }
    if (oneVersion) {
      // The version-level pair takes expectedVersion; the record-level pair
      // does not — the rename made that distinction explicit, so honour it.
      await withVersion(
        async () => (await api.call((c) => c.getRecord({ id }))).recordVersion,
        (current) =>
          verb === "archive"
            ? api.call((c) => c.archiveRecordVersion({ id, expectedVersion: current.version }))
            : api.call((c) => c.restoreRecordVersion({ id, expectedVersion: current.version })),
      )
    } else {
      const detail = await getDetail(api, id)
      const recordId = detail.recordVersion.recordId
      await api.call((c) =>
        verb === "archive" ? c.archiveRecord({ recordId }) : c.restoreRecord({ recordId }),
      )
    }
    note(
      `${verb === "archive" ? "Archived" : "Restored"} ${oneVersion ? "version" : "record"} ${id}.`,
    )
  })
}
