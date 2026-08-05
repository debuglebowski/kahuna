import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { findField } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Edges between records.
 *
 * A relation is NOT a top-level noun: its type is a field on a concept
 * (`FieldKind` includes `relation`, with `config.target`), and an edge is owned
 * by the record it starts from and named by that field. So this is
 * `record relation add`, and it always takes the field name.
 */
const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

export const relationCommands: ReadonlyArray<Command> = [
  {
    path: "record relation add",
    summary: "Link one record to another through a relation field",
    usage: "record relation add <from-id> --field <name> --to <record-id>",
    options: { field: { type: "string" }, to: { type: "string" } },
    run: async (ctx) => {
      const [fromId] = ctx.args
      const fieldName = ctx.flags.field as string | undefined
      const to = ctx.flags.to as string | undefined
      if (!fromId || !fieldName || !to) {
        throw new CliError("Need <from-id> --field <name> --to <record-id>.", EXIT.usage)
      }
      await withApi(async (api) => {
        const detail = await api.call((c) => c.getRecord({ id: fromId }))
        const field = findField(detail.fields, fieldName)
        if (field.kind !== "relation") {
          throw new CliError(
            `"${field.name}" is a ${field.kind} field, not a relation.`,
            EXIT.usage,
            `Relation fields on ${detail.concept.name}: ${
              detail.fields
                .filter((f) => f.kind === "relation")
                .map((f) => f.name)
                .join(", ") || "(none)"
            }`,
          )
        }
        if (ctx.flags["dry-run"]) {
          note(`Would link ${fromId} -> ${to} via "${field.name}".`)
          return
        }
        // `toRecordId` targets the lineage ("Latest"), which is what a person
        // means by "link to that record"; pinning a version is a separate ask.
        await api.call((c) => c.createRelation({ fieldId: field.id, fromId, toRecordId: to }))
        note(`Linked ${fromId} -> ${to} via "${field.name}".`)
      })
    },
  },
  {
    path: "record relation remove",
    summary: "Remove a link by its relation id",
    usage: "record relation remove <relation-id>",
    run: async (ctx) => {
      const [relationId] = ctx.args
      if (!relationId) {
        throw new CliError(
          "Which link?",
          EXIT.usage,
          "`km record relation list <id>` prints the relation ids.",
        )
      }
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would remove relation ${relationId}.`)
          return
        }
        await api.call((c) => c.removeRelation({ relationId }))
        note(`Removed relation ${relationId}.`)
      })
    },
  },
  {
    path: "record relation list",
    summary: "Show what a record is linked to",
    usage: "record relation list <id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(async (api) => {
        const detail = await api.call((c) => c.getRecord({ id }))
        printRows(
          ctx.format,
          detail.related.map((r) => ({ ...(r as unknown as Record<string, unknown>) })),
        )
      })
    },
  },
]
