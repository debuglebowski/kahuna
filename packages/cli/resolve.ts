import { readFileSync } from "node:fs"
import type { Concept, Field, RecordVersion } from "@kahunalabs/contract"
import { CliError, EXIT } from "./errors.ts"
import { asRichText, markdownToRichText } from "./richtext.ts"
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

/**
 * A file property's value as plain text: the filename(s), comma-joined. A file
 * field's value arrives as one `FileRef` (single) or a `FileRef[]` (multiple),
 * projected server-side from the record's attachments; anything else (absent,
 * or an unexpected shape) reads as empty. JSON output keeps the refs instead, so
 * a script still gets the ids `attachment download` needs.
 */
export const fileNames = (value: unknown): string => {
  const refs = Array.isArray(value) ? value : value == null ? [] : [value]
  return refs
    .map((r) =>
      r && typeof r === "object" && typeof (r as { filename?: unknown }).filename === "string"
        ? (r as { filename: string }).filename
        : "",
    )
    .filter(Boolean)
    .join(", ")
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
 * The org's default currency, as far as the CLI could find out: a code, `null`
 * when the org has none set, or `"unavailable"` when the server could not be
 * asked (one that predates the setting). Only consulted for a bare amount.
 */
export type DefaultCurrency = string | null | "unavailable"

/** `--help` notes for any command taking `--field name=value`. */
export const FIELD_VALUE_HELP = `Field values are read by the field's kind:
  money     1200 SEK | SEK 1200 | 1,200.50 EUR | 1200 (org default currency)
            | {"amount":1200,"currency":"SEK"}
  richtext  markdown (paragraphs, headings, lists, links, bold/italic, code)
            | {"doc":{...},"text":"..."} JSON
  bool      true/false, yes/no, 1/0      json   any JSON
  enum      one of the field's options (case-insensitive)
  multiple  a,b | a; b | ["a","b"] — each item read by the kind above
            (money: ";" only, a comma is a thousands separator)
  name=     (empty) clears the field
  name=@file.md   reads the value from a file (any kind); @@ = a literal leading @`

export interface CoerceOptions {
  readonly defaultCurrency?: DefaultCurrency
  /** Reads `@path` values. Injected so tests need no filesystem. */
  readonly readFile?: (path: string) => string
}

/**
 * `@path` reads the value from a file — the only sane way to pass a policy
 * document through a shell. Every kind gets it, not just richtext, so the rule
 * is one rule. A literal leading `@` is written `@@`. Trailing newlines are
 * dropped, like `$(cat file)`, so `echo 12 > n` works for a number field.
 */
const expandFileValue = (
  field: Field,
  text: string,
  readFile: (path: string) => string,
): string => {
  if (!text.startsWith("@")) return text
  if (text.startsWith("@@")) return text.slice(1)
  const path = text.slice(1)
  let content: string
  try {
    content = readFile(path)
  } catch {
    throw new CliError(
      `Cannot read ${path} (field "${field.name}").`,
      EXIT.notFound,
      'A value starting with @ is read from that file. For a literal leading @, double it: "@@".',
    )
  }
  return content.replace(/(?:\r?\n)+$/, "")
}

const defaultReadFile = (path: string): string => readFileSync(path, "utf8")

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
  options: CoerceOptions = {},
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const raw of assignments) {
    const eq = raw.indexOf("=")
    if (eq === -1) {
      throw new CliError(`Expected name=value, got "${raw}".`, EXIT.usage)
    }
    const field = findField(fields, raw.slice(0, eq))
    const text = expandFileValue(field, raw.slice(eq + 1), options.readFile ?? defaultReadFile)
    out[field.id] = coerceValue(field, text, options)
  }
  return out
}

/** Does any of these assignments target a money field? Lets a command skip
 *  the settings round-trip when nothing needs a default currency. */
export const assignsMoney = (
  fields: ReadonlyArray<Field>,
  assignments: ReadonlyArray<string>,
): boolean =>
  assignments.some((raw) => {
    const eq = raw.indexOf("=")
    if (eq === -1) return false
    try {
      return findField(fields, raw.slice(0, eq)).kind === "money"
    } catch {
      return false // reported properly by parseFieldAssignments
    }
  })

/** The org default currency, or why there isn't one. Never throws: a server
 *  without the setting must still accept "1200 SEK". */
export const fetchDefaultCurrency = async (api: Api): Promise<DefaultCurrency> => {
  try {
    const settings = await api.call((c) => c.getOrgSettings())
    return settings.defaultCurrency
  } catch {
    return "unavailable"
  }
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

/**
 * An amount, optionally with a three-letter code on either side ("1200",
 * "1200 SEK", "SEK 1 200", "1,200.50 eur"), or the stored shape as JSON.
 *
 * A dot is the only decimal mark; a comma or space is accepted ONLY between
 * groups of three digits. "1200,50" is refused rather than read either way —
 * "1,200" meaning 1.2 in one locale and 1200 in another is a silent 1000x error.
 * No code falls back to the org default; no default is an error, never USD.
 */
const AMOUNT = String.raw`-?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.\d+)?`
const MONEY_AFTER = new RegExp(`^(${AMOUNT})\\s*([A-Za-z]{3})?$`)
const MONEY_BEFORE = new RegExp(`^([A-Za-z]{3})\\s*(${AMOUNT})$`)

export const parseMoney = (
  field: Field,
  text: string,
  defaultCurrency: DefaultCurrency | undefined,
): { readonly amount: number; readonly currency: string } => {
  const s = text.trim()
  const bad = (why: string, hint?: string) =>
    new CliError(`"${text}" ${why} (field "${field.name}").`, EXIT.usage, hint)

  if (s.startsWith("{")) {
    let v: unknown
    try {
      v = JSON.parse(s)
    } catch {
      throw bad("is not valid JSON")
    }
    const m = v as { amount?: unknown; currency?: unknown }
    if (typeof m.amount !== "number" || !Number.isFinite(m.amount)) {
      throw bad("needs a numeric amount", 'Shape: {"amount": 1200, "currency": "SEK"}')
    }
    if (m.currency === undefined) return parseMoney(field, String(m.amount), defaultCurrency)
    if (typeof m.currency !== "string" || !/^[A-Za-z]{3}$/.test(m.currency)) {
      throw bad("has no valid currency code", "Use a three-letter code, e.g. SEK.")
    }
    return { amount: m.amount, currency: m.currency.toUpperCase() }
  }

  const after = s.match(MONEY_AFTER)
  const before = after ? null : s.match(MONEY_BEFORE)
  const amountText = after?.[1] ?? before?.[2]
  const code = after?.[2] ?? before?.[1]
  if (amountText === undefined) {
    throw bad(
      "is not an amount",
      'Write "1200", "1200 SEK" or "1,200.50 EUR" — a dot for decimals, a comma or space only between thousands.',
    )
  }
  const amount = Number(amountText.replace(/[ ,]/g, ""))
  if (!Number.isFinite(amount)) throw bad("is not an amount")
  if (code) return { amount, currency: code.toUpperCase() }

  if (typeof defaultCurrency === "string" && defaultCurrency !== "unavailable") {
    return { amount, currency: defaultCurrency }
  }
  throw bad(
    "has no currency",
    defaultCurrency === "unavailable"
      ? `This server has no org default currency setting. Name one: "${amountText} SEK".`
      : `No org default currency is set. Name one ("${amountText} SEK"), or set a default in Settings → Organization.`,
  )
}

/** A richtext value: `{doc, text}` / bare-doc JSON as-is, anything else as markdown. */
const parseRichText = (field: Field, text: string): unknown => {
  const s = text.trim()
  if (s.startsWith("{")) {
    let v: unknown
    try {
      v = JSON.parse(s)
    } catch {
      // Not JSON at all — prose that happens to open with a brace.
      return markdownToRichText(text)
    }
    const rt = asRichText(v)
    if (rt) return rt
    // Valid JSON that is not rich text is almost certainly a mistake, not prose.
    throw new CliError(
      `"${field.name}" got JSON that is not rich text.`,
      EXIT.usage,
      'Pass markdown, or {"doc": {"type": "doc", ...}, "text": "..."}. To store literal JSON as text, put it in a ```code block```.',
    )
  }
  return markdownToRichText(text)
}

/**
 * An enum value must be one of the field's options. Matched exactly first, then
 * case-insensitively when that picks exactly one — a CSV saying "legal" for
 * "Legal" is a typo worth forgiving; anything else is refused HERE with the
 * options listed, not left to a server error that names none of the input.
 */
const parseEnum = (field: Field, text: string): string => {
  const options = field.config.options ?? []
  const s = text.trim()
  if (options.includes(s)) return s
  const loose = options.filter((o) => norm(o) === norm(s))
  if (loose.length === 1 && loose[0] !== undefined) return loose[0]
  throw new CliError(
    `"${s}" is not an option of "${field.name}".`,
    EXIT.usage,
    options.length > 0
      ? `Options: ${options.join(", ")}`
      : `"${field.name}" has no options defined yet.`,
  )
}

/** Kinds whose `config.multiple` means "a list of values". relation uses
 *  `cardinality`, file is refused outright, and json/richtext already take any
 *  shape — none of them split. */
const LISTABLE = new Set<Field["kind"]>(["text", "number", "date", "enum", "user", "bool", "money"])

/**
 * A `multiple` field's value: a JSON array (`["a","b"]`), else a separated list.
 * The separator is `;` when the text has one — what `record export` writes, so
 * an export re-imports unchanged — otherwise `,`. Money splits ONLY on `;`: a
 * comma is a thousands separator there, and "1,200 SEK" read as two amounts is
 * a silent 1000x error. Each item is coerced by the field's kind; blank items
 * are dropped, so a trailing separator is harmless.
 */
const parseList = (field: Field, text: string, options: CoerceOptions): unknown[] => {
  const s = text.trim()
  if (s.startsWith("[")) {
    let v: unknown
    try {
      v = JSON.parse(s)
    } catch {
      v = undefined
    }
    if (Array.isArray(v)) {
      return v.map((item) => {
        if (item === null || item === undefined) {
          throw new CliError(`"${field.name}" got a null in its list.`, EXIT.usage)
        }
        const t = typeof item === "string" ? item : JSON.stringify(item)
        return coerceOne(field, t, options)
      })
    }
    // Not a JSON array — "[draft] notes" is text; fall through to splitting.
  }
  const sep = field.kind === "money" || s.includes(";") ? ";" : ","
  return s
    .split(sep)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      try {
        return coerceOne(field, item, options)
      } catch (e) {
        if (field.kind === "money" && e instanceof CliError) {
          throw new CliError(
            e.message,
            e.exitCode,
            'Several amounts: separate with ";" ("1200 SEK; 5 EUR"), or pass a JSON array.',
          )
        }
        throw e
      }
    })
}

/**
 * One value, coerced by its field's kind. Shared by `--field` and `record
 * import`, so a CSV cell and an argument can never mean different things.
 */
export const coerceValue = (field: Field, text: string, options: CoerceOptions = {}): unknown => {
  // An explicit empty value clears the field, for every kind. `--field x=` is
  // the only way to say "unset" without a separate flag.
  if (text === "") return null
  // A `multiple` field takes a list; sending a bare string is a server refusal
  // whose message ("expects a list") names nothing the user typed.
  if (field.config.multiple && LISTABLE.has(field.kind)) return parseList(field, text, options)
  return coerceOne(field, text, options)
}

/** A single (non-list) value, coerced by its field's kind. */
const coerceOne = (field: Field, text: string, options: CoerceOptions): unknown => {
  switch (field.kind) {
    // Files are attachments, never state — say how to set one instead of letting
    // the server refuse a filename it can't use.
    case "file":
      throw new CliError(
        `"${field.name}" holds files, not text.`,
        EXIT.usage,
        `On create: --file "${field.name}=<path>". On an existing record: attachment upload <path> --record <record-id> --field "${field.name}"`,
      )
    case "number": {
      const n = Number(text)
      if (Number.isNaN(n)) {
        throw new CliError(`"${text}" is not a number (field "${field.name}").`, EXIT.usage)
      }
      return n
    }
    case "money":
      return parseMoney(field, text, options.defaultCurrency)
    case "richtext":
      return parseRichText(field, text)
    case "bool": {
      if (["true", "yes", "1"].includes(norm(text))) return true
      if (["false", "no", "0"].includes(norm(text))) return false
      throw new CliError(`"${text}" is not true/false (field "${field.name}").`, EXIT.usage)
    }
    case "enum":
      return parseEnum(field, text)
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
