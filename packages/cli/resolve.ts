import type { Concept, Field, RecordVersion } from "@kahunalabs/contract"
import { CliError, EXIT } from "./errors.ts"
import type { Api } from "./transport.ts"

/**
 * Names in, ids out.
 *
 * Concepts carry a stable slug, but fields, records and roles are UUID-keyed by
 * design — and nobody types a UUID. Everything user-facing therefore goes
 * through here, and an ambiguous name is an ERROR listing the candidates, never
 * a silent pick: choosing one for them is how a script quietly edits the wrong
 * record for a month.
 */

const norm = (s: string): string => s.trim().toLowerCase()

/** Ambiguity is a failure with the answer in it — the ids you could have meant. */
const ambiguous = (kind: string, name: string, options: ReadonlyArray<string>): CliError =>
  new CliError(
    `"${name}" matches ${options.length} ${kind}s.`,
    EXIT.usage,
    `Be more specific, or use an id:\n${options.map((o) => `  ${o}`).join("\n")}`,
  )

export const findConcept = (concepts: ReadonlyArray<Concept>, name: string): Concept => {
  const n = norm(name)
  // Exact id, then exact slug, then exact name — all unambiguous by definition.
  const exact =
    concepts.find((c) => c.id === name) ??
    concepts.find((c) => norm(c.slug) === n) ??
    concepts.find((c) => norm(c.name) === n)
  if (exact) return exact

  // Only then a prefix, which CAN be ambiguous.
  const partial = concepts.filter((c) => norm(c.slug).startsWith(n) || norm(c.name).startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  if (partial.length > 1) {
    throw ambiguous(
      "concept",
      name,
      partial.map((c) => `${c.slug}  ${c.name}`),
    )
  }
  throw new CliError(
    `No concept named "${name}".`,
    EXIT.notFound,
    `Known concepts: ${concepts.map((c) => c.slug).join(", ") || "(none)"}`,
  )
}

export const findField = (fields: ReadonlyArray<Field>, name: string): Field => {
  const n = norm(name)
  const exact = fields.find((f) => f.id === name) ?? fields.find((f) => norm(f.name) === n)
  if (exact) return exact
  const partial = fields.filter((f) => norm(f.name).startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  if (partial.length > 1) {
    throw ambiguous(
      "field",
      name,
      partial.map((f) => `${f.name}  (${f.kind})`),
    )
  }
  throw new CliError(
    `No field named "${name}".`,
    EXIT.notFound,
    `Known fields: ${fields.map((f) => f.name).join(", ") || "(none)"}`,
  )
}

/** Looks like a UUID, so it can be used as an id without a lookup. */
export const isId = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/**
 * The display label of a record version, from its concept's title field.
 *
 * Mirrors what the SPA shows. A record with no title field, or an empty one,
 * falls back to the id — never to an empty string, which would render as a
 * blank row that cannot be selected or reported.
 */
export const labelOf = (
  version: RecordVersion,
  concept: Concept,
  fields: ReadonlyArray<Field>,
): string => {
  const titleField = concept.titleFieldId
    ? fields.find((f) => f.id === concept.titleFieldId)
    : undefined
  const raw = titleField ? version.state[titleField.id] : undefined
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw)
  return text || version.id
}

/** A concept plus its fields — what nearly every record command needs first. */
export interface ConceptContext {
  readonly concept: Concept
  readonly fields: ReadonlyArray<Field>
}

export const conceptContext = async (api: Api, name: string): Promise<ConceptContext> => {
  const concepts = await api.call((c) => c.listConcepts({}))
  const concept = findConcept(concepts, name)
  const fields = await api.call((c) => c.listFields({ conceptId: concept.id }))
  return { concept, fields }
}

/**
 * Turn `--field name=value` pairs into the `{fieldId: value}` map the API takes.
 *
 * Values are coerced by the FIELD's kind, not by guessing from the text: `1` in
 * a text field must stay the string "1", and `false` in a text field must not
 * become a boolean. Getting that backwards writes the wrong type into a jsonb
 * column where nothing will complain until a filter silently stops matching.
 */
export const parseFieldAssignments = (
  fields: ReadonlyArray<Field>,
  assignments: ReadonlyArray<string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const raw of assignments) {
    const eq = raw.indexOf("=")
    if (eq === -1) {
      throw new CliError(`Expected name=value, got "${raw}".`, EXIT.usage)
    }
    const field = findField(fields, raw.slice(0, eq))
    const text = raw.slice(eq + 1)
    out[field.id] = coerce(field, text)
  }
  return out
}

/** Splits repeated `--flag key=value` occurrences into pairs. `raw` is
 *  whatever `parseArgs` produced for a `{multiple: true}` string option:
 *  undefined (never passed), a single string (passed once), or an array
 *  (passed more than once) — node collapses the single-occurrence case rather
 *  than always returning a one-element array. Shared by any command with a
 *  repeated `--flag key=value` option (field config, dashboard widget/group
 *  `--set`). */
export const parseKeyValuePairs = (
  raw: unknown,
  shape: string,
): ReadonlyArray<[string, string]> => {
  if (raw === undefined) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((entry) => {
    const s = String(entry)
    const eq = s.indexOf("=")
    if (eq === -1) throw new CliError(`Expected ${shape}, got "${s}".`, EXIT.usage)
    return [s.slice(0, eq), s.slice(eq + 1)] as [string, string]
  })
}

const coerce = (field: Field, text: string): unknown => {
  // An explicit empty value clears the field, for every kind. `--field x=` is
  // the only way to say "unset" without a separate flag.
  if (text === "") return null
  switch (field.kind) {
    case "number":
    case "money": {
      const n = Number(text)
      if (Number.isNaN(n)) {
        throw new CliError(`"${text}" is not a number (field "${field.name}").`, EXIT.usage)
      }
      return n
    }
    case "bool": {
      if (["true", "yes", "1"].includes(norm(text))) return true
      if (["false", "no", "0"].includes(norm(text))) return false
      throw new CliError(`"${text}" is not true/false (field "${field.name}").`, EXIT.usage)
    }
    case "json":
      try {
        return JSON.parse(text)
      } catch {
        throw new CliError(`"${field.name}" needs valid JSON.`, EXIT.usage)
      }
    default:
      return text
  }
}
