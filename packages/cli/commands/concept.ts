import type { FieldKind } from "@alltinghq/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { conceptContext, findConcept, findField, parseKeyValuePairs } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

/** The kinds `concept field add --kind` accepts, mirrored from the contract's
 *  `FieldKind` so an unknown kind fails here with the list rather than as a
 *  schema decode error from the server. */
const KINDS: ReadonlyArray<FieldKind> = [
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
  "user",
  "json",
  "money",
  "richtext",
]

/** Flags shared by `concept field add` and `concept field update` for the
 *  parts of `FieldConfig` beyond options/required/unique: relation shape,
 *  multi-value, text/number format, and enum presentation/workflow. Kept in
 *  one place so both commands validate and merge identically. */
const FIELD_CONFIG_OPTIONS = {
  cardinality: { type: "string" as const },
  "inverse-name": { type: "string" as const },
  "inverse-plural-name": { type: "string" as const },
  multiple: { type: "boolean" as const },
  format: { type: "string" as const },
  "option-color": { type: "string" as const, multiple: true },
  transition: { type: "string" as const, multiple: true },
}

/** Overlays `--cardinality`/`--inverse-name`/`--inverse-plural-name`/
 *  `--multiple`/`--format`/`--option-color`/`--transition` onto a field
 *  `config` object, IN PLACE. `config` must already hold whatever should
 *  survive untouched (the empty object on `add`, the existing field's config
 *  spread onto a fresh object on `update`) — this only ever adds or replaces
 *  the specific keys a flag was given for, same merge discipline as the
 *  options/required/unique flags each caller applies around this call.
 *  `optionColors`/`transitions` are themselves maps, so a repeated flag here
 *  merges into the existing map rather than replacing it wholesale — the same
 *  reasoning one level down. */
const applyFieldConfigFlags = (
  config: Record<string, unknown>,
  flags: Record<string, string | boolean | Array<string | boolean> | undefined>,
): void => {
  const cardinality = flags.cardinality as string | undefined
  if (cardinality !== undefined) {
    if (cardinality !== "one" && cardinality !== "many") {
      throw new CliError("--cardinality takes one or many.", EXIT.usage)
    }
    config.cardinality = cardinality
  }
  if (flags["inverse-name"] !== undefined) config.inverseName = flags["inverse-name"]
  if (flags["inverse-plural-name"] !== undefined) {
    config.inversePluralName = flags["inverse-plural-name"]
  }
  if (flags.multiple) config.multiple = true
  if (flags.format !== undefined) config.format = flags.format

  const colorPairs = parseKeyValuePairs(flags["option-color"], "option=hex")
  if (colorPairs.length > 0) {
    const optionColors: Record<string, string> = {
      ...(config.optionColors as Record<string, string> | undefined),
    }
    for (const [option, hex] of colorPairs) optionColors[option] = hex
    config.optionColors = optionColors
  }

  const transitionPairs = parseKeyValuePairs(flags.transition, "from=to,to2")
  if (transitionPairs.length > 0) {
    const transitions: Record<string, ReadonlyArray<string>> = {
      ...(config.transitions as Record<string, ReadonlyArray<string>> | undefined),
    }
    for (const [from, toList] of transitionPairs) {
      transitions[from] = toList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    }
    config.transitions = transitions
  }
}

export const conceptCommands: ReadonlyArray<Command> = [
  {
    path: "concept list",
    summary: "List the concepts in this organization",
    usage: "concept list [--archived] [--counts] [--json]",
    options: { archived: { type: "boolean" }, counts: { type: "boolean" } },
    run: async (ctx) => {
      await withApi(async (api) => {
        const concepts = await api.call((c) =>
          c.listConcepts({
            includeArchived: Boolean(ctx.flags.archived),
            withCounts: Boolean(ctx.flags.counts),
          }),
        )
        printRows(
          ctx.format,
          concepts.map((c) => ({
            slug: c.slug,
            name: c.name,
            records: c.recordCount ?? "",
            versioned: c.versioningEnabled ? "yes" : "",
            single: c.singleRecord ? "yes" : "",
            archived: c.archivedAt ? "yes" : "",
            id: c.id,
          })),
          ["slug", "name", "records", "versioned", "single", "archived", "id"],
        )
      })
    },
  },
  {
    path: "concept get",
    summary: "Show one concept and its fields",
    usage: "concept get <concept> [--json]",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which concept?", EXIT.usage)
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, name)
        if (ctx.format === "json") {
          printOne(ctx.format, { ...concept, fields } as unknown as Record<string, unknown>)
          return
        }
        printOne(ctx.format, {
          slug: concept.slug,
          name: concept.name,
          plural: concept.pluralName ?? "",
          description: concept.description ?? "",
          versioning: concept.versioningEnabled ? "on" : "off",
          singleRecord: concept.singleRecord ? "yes" : "no",
          titleField: fields.find((f) => f.id === concept.titleFieldId)?.name ?? "(none)",
          id: concept.id,
        })
        note("")
        printRows(
          "table",
          fields.map((f) => ({
            field: f.name,
            kind: f.kind,
            required: f.config.requirement === "required" ? "yes" : "",
            unique: f.config.unique ? "yes" : "",
            target: f.config.target ?? "",
            id: f.id,
          })),
          ["field", "kind", "required", "unique", "target", "id"],
        )
      })
    },
  },
  {
    path: "concept create",
    summary: "Create a concept",
    usage: "concept create <name> [--color <hex>] [--description <text>] [--plural <name>]",
    options: {
      color: { type: "string" },
      description: { type: "string" },
      plural: { type: "string" },
      icon: { type: "string" },
    },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A name is required.", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would create concept "${name}".`)
          return
        }
        const created = await api.call((c) =>
          c.createConcept({ name, color: (ctx.flags.color as string | undefined) ?? null }),
        )
        // createConcept takes only name + colour + access. Anything else is a
        // second call — stated plainly rather than pretended to be atomic.
        const description = ctx.flags.description as string | undefined
        const plural = ctx.flags.plural as string | undefined
        const icon = ctx.flags.icon as string | undefined
        if (description || plural || icon) {
          await api.call((c) =>
            c.updateConcept({
              id: created.id,
              description: description ?? null,
              pluralName: plural,
              icon,
            }),
          )
        }
        note(`Created concept "${created.name}" (${created.slug}).`)
      })
    },
  },
  {
    path: "concept update",
    summary: "Rename a concept or change its settings",
    usage:
      "concept update <concept> [--name <n>] [--plural <n>] [--description <t>] [--icon <i>] [--color <hex>] [--versioning on|off] [--title-field <field>] [--single-record on|off]",
    options: {
      name: { type: "string" },
      plural: { type: "string" },
      description: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      versioning: { type: "string" },
      "title-field": { type: "string" },
      "single-record": { type: "string" },
    },
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which concept?", EXIT.usage)
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, target)
        const onOff = (flag: string, value: unknown): boolean | undefined => {
          if (value === undefined) return undefined
          if (value === "on" || value === "true") return true
          if (value === "off" || value === "false") return false
          throw new CliError(`--${flag} takes on or off.`, EXIT.usage)
        }
        const versioning = onOff("versioning", ctx.flags.versioning)
        const single = onOff("single-record", ctx.flags["single-record"])
        const titleFieldName = ctx.flags["title-field"] as string | undefined

        if (ctx.flags["dry-run"]) {
          note(`Would update "${concept.name}".`)
          return
        }

        // Three separate procedures, because the API has three. Ordered so the
        // cheapest, least destructive one runs first: if `single-record` is
        // rejected the rename has still landed and can be seen.
        const patch = {
          id: concept.id,
          description: (ctx.flags.description as string | undefined) ?? concept.description,
          name: ctx.flags.name as string | undefined,
          pluralName: ctx.flags.plural as string | undefined,
          icon: ctx.flags.icon as string | undefined,
          color: ctx.flags.color as string | undefined,
          versioningEnabled: versioning,
        }
        const touchesConcept =
          patch.name !== undefined ||
          patch.pluralName !== undefined ||
          patch.icon !== undefined ||
          patch.color !== undefined ||
          versioning !== undefined ||
          ctx.flags.description !== undefined
        if (touchesConcept) await api.call((c) => c.updateConcept(patch))

        if (titleFieldName !== undefined) {
          const field = findField(fields, titleFieldName)
          await api.call((c) => c.setConceptTitleField({ id: concept.id, titleFieldId: field.id }))
        }
        if (single !== undefined) {
          await api.call((c) =>
            c.setConceptSingleRecord({ conceptId: concept.id, singleRecord: single }),
          )
        }
        note(`Updated "${concept.name}".`)
      })
    },
  },
  {
    path: "concept archive",
    summary: "Archive a concept",
    usage: "concept archive <concept>",
    run: async (ctx) => conceptLifecycle(ctx.args[0], ctx, "archive"),
  },
  {
    path: "concept restore",
    summary: "Restore an archived concept",
    usage: "concept restore <concept>",
    run: async (ctx) => conceptLifecycle(ctx.args[0], ctx, "restore"),
  },
  {
    path: "concept delete",
    summary: "PURGE a concept and everything in it",
    usage: "concept delete <concept> --yes",
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which concept?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete "${target}" and all of its records`)
      await withApi(async (api) => {
        const concepts = await api.call((c) => c.listConcepts({ includeArchived: true }))
        const concept = findConcept(concepts, target)
        if (ctx.flags["dry-run"]) {
          note(`Would PURGE "${concept.name}" and every record in it. This cannot be undone.`)
          return
        }
        await api.call((c) => c.deleteConcept({ id: concept.id }))
        note(`Purged "${concept.name}".`)
      })
    },
  },

  // ── fields ────────────────────────────────────────────────────────────────
  {
    path: "concept field list",
    summary: "List a concept's fields",
    usage: "concept field list <concept> [--archived]",
    options: { archived: { type: "boolean" } },
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which concept?", EXIT.usage)
      await withApi(async (api) => {
        const concepts = await api.call((c) => c.listConcepts({}))
        const concept = findConcept(concepts, target)
        const fields = await api.call((c) =>
          c.listFields({ conceptId: concept.id, includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          fields.map((f) => ({
            name: f.name,
            kind: f.kind,
            position: f.position,
            required: f.config.requirement === "required" ? "yes" : "",
            unique: f.config.unique ? "yes" : "",
            target: f.config.target ?? "",
            archived: f.archivedAt ? "yes" : "",
            id: f.id,
          })),
          ["name", "kind", "position", "required", "unique", "target", "archived", "id"],
        )
      })
    },
  },
  {
    path: "concept field add",
    summary: "Add a field to a concept",
    usage:
      "concept field add <concept> --name <n> --kind <kind> [--options a,b,c] [--target <concept>] [--cardinality one|many] [--inverse-name <n>] [--inverse-plural-name <n>] [--multiple] [--format <fmt>] [--option-color <opt>=<hex>]... [--transition <from>=<to,to2>]... [--required] [--unique]",
    options: {
      name: { type: "string" },
      kind: { type: "string" },
      options: { type: "string" },
      target: { type: "string" },
      required: { type: "boolean" },
      unique: { type: "boolean" },
      icon: { type: "string" },
      ...FIELD_CONFIG_OPTIONS,
    },
    run: async (ctx) => {
      const [target] = ctx.args
      const name = ctx.flags.name as string | undefined
      const kind = ctx.flags.kind as string | undefined
      if (!target || !name || !kind) {
        throw new CliError("Need <concept> --name <n> --kind <kind>.", EXIT.usage)
      }
      if (!KINDS.includes(kind as FieldKind)) {
        throw new CliError(
          `Unknown field kind "${kind}".`,
          EXIT.usage,
          `Kinds: ${KINDS.join(", ")}`,
        )
      }
      await withApi(async (api) => {
        const concepts = await api.call((c) => c.listConcepts({}))
        const concept = findConcept(concepts, target)

        const config: Record<string, unknown> = {}
        if (ctx.flags.options) {
          config.options = String(ctx.flags.options)
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        }
        if (ctx.flags.required) config.requirement = "required"
        if (ctx.flags.unique) config.unique = true
        applyFieldConfigFlags(config, ctx.flags)
        if (kind === "relation") {
          // A relation field is the TYPE of an edge, and it is useless without a
          // target — refuse now rather than create a field nothing can point at.
          const targetName = ctx.flags.target as string | undefined
          if (!targetName) {
            throw new CliError(
              "A relation field needs --target <concept>.",
              EXIT.usage,
              "The target is the concept the edges point at.",
            )
          }
          config.target = findConcept(concepts, targetName).id
        }

        if (ctx.flags["dry-run"]) {
          note(`Would add ${kind} field "${name}" to "${concept.name}".`)
          return
        }
        const field = await api.call((c) =>
          c.addField({
            conceptId: concept.id,
            name,
            kind: kind as FieldKind,
            config,
            icon: (ctx.flags.icon as string | undefined) ?? null,
          }),
        )
        note(`Added "${field.name}" (${field.kind}) to "${concept.name}".`)
      })
    },
  },
  {
    path: "concept field update",
    summary: "Rename a field or change its config",
    usage:
      "concept field update <concept> <field> [--name <n>] [--options a,b,c] [--cardinality one|many] [--inverse-name <n>] [--inverse-plural-name <n>] [--multiple] [--format <fmt>] [--option-color <opt>=<hex>]... [--transition <from>=<to,to2>]... [--required] [--unique]",
    options: {
      name: { type: "string" },
      options: { type: "string" },
      required: { type: "boolean" },
      unique: { type: "boolean" },
      icon: { type: "string" },
      ...FIELD_CONFIG_OPTIONS,
    },
    run: async (ctx) => {
      const [target, fieldName] = ctx.args
      if (!target || !fieldName) throw new CliError("Need <concept> <field>.", EXIT.usage)
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, target)
        const field = findField(fields, fieldName)
        // Merge, never replace: `config` carries the relation target, the enum
        // options and the transitions, so sending a fresh object would silently
        // strip whatever this command did not mention.
        const config: Record<string, unknown> = { ...field.config }
        if (ctx.flags.options) {
          config.options = String(ctx.flags.options)
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        }
        if (ctx.flags.required) config.requirement = "required"
        if (ctx.flags.unique) config.unique = true
        applyFieldConfigFlags(config, ctx.flags)

        if (ctx.flags["dry-run"]) {
          note(`Would update field "${field.name}" on "${concept.name}".`)
          return
        }
        const updated = await api.call((c) =>
          c.updateField({
            id: field.id,
            name: ctx.flags.name as string | undefined,
            config,
            icon: ctx.flags.icon as string | undefined,
          }),
        )
        note(`Updated "${updated.name}".`)
      })
    },
  },
  {
    path: "concept field reorder",
    summary: "Set the field order for a concept",
    usage: "concept field reorder <concept> <field> [<field> ...]",
    run: async (ctx) => {
      const [target, ...names] = ctx.args
      if (!target || names.length === 0) {
        throw new CliError("Need <concept> and at least one field.", EXIT.usage)
      }
      await withApi(async (api) => {
        const { concept, fields } = await conceptContext(api, target)
        const named = names.map((n) => findField(fields, n))
        // Fields the caller left out keep their relative order AFTER the named
        // ones, so a partial reorder cannot silently drop a column from the UI.
        const rest = fields.filter((f) => !named.some((n) => n.id === f.id))
        const orders = [...named, ...rest].map((f, i) => ({ id: f.id, position: i }))
        if (ctx.flags["dry-run"]) {
          note(`Would order: ${[...named, ...rest].map((f) => f.name).join(", ")}`)
          return
        }
        await api.call((c) => c.reorderFields({ conceptId: concept.id, orders }))
        note(`Reordered ${orders.length} fields on "${concept.name}".`)
      })
    },
  },
  {
    path: "concept field archive",
    summary: "Archive a field (its data is kept)",
    usage: "concept field archive <concept> <field>",
    run: async (ctx) => fieldLifecycle(ctx, "archive"),
  },
  {
    path: "concept field restore",
    summary: "Restore an archived field",
    usage: "concept field restore <concept> <field>",
    run: async (ctx) => fieldLifecycle(ctx, "restore"),
  },
  {
    path: "concept field delete",
    summary: "PURGE a field and its values",
    usage: "concept field delete <concept> <field> --yes",
    run: async (ctx) => {
      const [target, fieldName] = ctx.args
      if (!target || !fieldName) throw new CliError("Need <concept> <field>.", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete field "${fieldName}"`)
      await fieldLifecycle(ctx, "delete")
    },
  },
]

const conceptLifecycle = async (
  target: string | undefined,
  ctx: { flags: Record<string, unknown>; format: string },
  verb: "archive" | "restore",
): Promise<void> => {
  if (!target) throw new CliError("Which concept?", EXIT.usage)
  await withApi(async (api) => {
    const concepts = await api.call((c) => c.listConcepts({ includeArchived: true }))
    const concept = findConcept(concepts, target)
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} "${concept.name}".`)
      return
    }
    await api.call((c) =>
      verb === "archive"
        ? c.archiveConcept({ id: concept.id })
        : c.restoreConcept({ id: concept.id }),
    )
    note(`${verb === "archive" ? "Archived" : "Restored"} "${concept.name}".`)
  })
}

const fieldLifecycle = async (
  ctx: { args: ReadonlyArray<string>; flags: Record<string, unknown> },
  verb: "archive" | "restore" | "delete",
): Promise<void> => {
  const [target, fieldName] = ctx.args
  if (!target || !fieldName) throw new CliError("Need <concept> <field>.", EXIT.usage)
  await withApi(async (api) => {
    const concepts = await api.call((c) => c.listConcepts({ includeArchived: true }))
    const concept = findConcept(concepts, target)
    const fields = await api.call((c) =>
      c.listFields({ conceptId: concept.id, includeArchived: true }),
    )
    const field = findField(fields, fieldName)
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} field "${field.name}" on "${concept.name}".`)
      return
    }
    await api.call((c) =>
      verb === "archive"
        ? c.archiveField({ id: field.id })
        : verb === "restore"
          ? c.restoreField({ id: field.id })
          : c.deleteField({ id: field.id }),
    )
    note(
      `${verb === "delete" ? "Purged" : verb === "archive" ? "Archived" : "Restored"} "${field.name}".`,
    )
  })
}
