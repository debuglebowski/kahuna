/**
 * How results reach the terminal.
 *
 * ONE RULE ABOVE ALL: data on stdout, everything else on stderr. Progress
 * notes, warnings and errors go to stderr so `km record list x --json | jq`
 * never has to filter our chatter out of its input.
 */
export type Format = "table" | "json" | "csv"

/** A rendered row: ordered columns, primitive values. */
export type Row = Record<string, unknown>

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return ""
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** Printable width, counting a wide (CJK/emoji) glyph as two columns. */
const width = (s: string): number => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    n +=
      c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0x1f300 && c <= 0x1faff))
        ? 2
        : 1
  }
  return n
}

export const renderTable = (rows: ReadonlyArray<Row>, columns?: ReadonlyArray<string>): string => {
  if (rows.length === 0) return ""
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const body = rows.map((r) => cols.map((c) => cell(r[c])))
  const widths = cols.map((c, i) => Math.max(width(c), ...body.map((r) => width(r[i] ?? ""))))
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((v, i) => v + " ".repeat(Math.max(0, (widths[i] ?? 0) - width(v))))
      .join("  ")
      .trimEnd()
  return [line(cols.map((c) => c.toUpperCase())), ...body.map(line)].join("\n")
}

/** RFC 4180: quote when the value contains a comma, quote, CR or LF. */
export const renderCsv = (rows: ReadonlyArray<Row>, columns?: ReadonlyArray<string>): string => {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const esc = (v: unknown): string => {
    const s = cell(v)
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")
}

export const render = (
  format: Format,
  rows: ReadonlyArray<Row>,
  columns?: ReadonlyArray<string>,
): string => {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2)
    case "csv":
      return renderCsv(rows, columns)
    default:
      return renderTable(rows, columns)
  }
}

/** Print rows to stdout in the requested format. An empty set prints nothing
 *  in table form (a header with no rows reads as data) but still prints `[]`
 *  as JSON, because a consumer parsing our output needs valid JSON either way. */
export const printRows = (
  format: Format,
  rows: ReadonlyArray<Row>,
  columns?: ReadonlyArray<string>,
): void => {
  if (format === "table" && rows.length === 0) return
  const out = render(format, rows, columns)
  if (out) process.stdout.write(`${out}\n`)
}

/** A single object (not a list): JSON verbatim, or key/value lines. */
export const printOne = (format: Format, value: Row): void => {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  const keys = Object.keys(value)
  const pad = Math.max(...keys.map(width), 0)
  for (const k of keys) {
    process.stdout.write(`${k}${" ".repeat(pad - width(k))}  ${cell(value[k])}\n`)
  }
}

/** Human-facing note. stderr, so it never contaminates piped data. */
export const note = (message: string): void => {
  process.stderr.write(`${message}\n`)
}
