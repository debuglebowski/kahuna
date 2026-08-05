/**
 * CSV parsing for `record import`.
 *
 * Hand-written rather than a dependency, because the CLI is published and every
 * dependency is something a consumer inherits — and because the format is small
 * enough to implement correctly: RFC 4180 quoting, embedded commas, embedded
 * newlines, doubled quotes, and CRLF.
 *
 * The encoder lives in output.ts (`renderCsv`) so exporting and importing use
 * the same rules from opposite ends. `csv.test.ts` round-trips them together —
 * a quoting bug that both sides share would otherwise pass unnoticed.
 */
export interface ParsedCsv {
  readonly header: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

export const parseCsv = (input: string): ParsedCsv => {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let cell = ""
  let quoted = false
  let i = 0

  // A trailing newline is not an empty final row, and a BOM is not part of the
  // first header name — both are the classic ways a "working" importer puts a
  // phantom column or row into someone's data.
  const text = input.replace(/^﻿/, "")

  const endCell = (): void => {
    row.push(cell)
    cell = ""
  }
  const endRow = (): void => {
    endCell()
    // Skip a row that is entirely empty (the trailing newline case).
    if (!(row.length === 1 && row[0] === "")) rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === "") {
      quoted = true
      i++
      continue
    }
    if (ch === ",") {
      endCell()
      i++
      continue
    }
    if (ch === "\r") {
      // CRLF and a bare CR both end the row; the LF is consumed with it.
      endRow()
      i += text[i + 1] === "\n" ? 2 : 1
      continue
    }
    if (ch === "\n") {
      endRow()
      i++
      continue
    }
    cell += ch
    i++
  }
  if (cell !== "" || row.length > 0 || quoted) endRow()

  const [header = [], ...body] = rows
  return { header, rows: body }
}

/** Rows as objects keyed by header name, with short rows padded rather than
 *  dropped — a ragged file is common and losing its last column silently is not
 *  an acceptable way to handle it. */
export const csvToObjects = (input: string): ReadonlyArray<Record<string, string>> => {
  const { header, rows } = parseCsv(input)
  return rows.map((cells) => {
    const out: Record<string, string> = {}
    header.forEach((name, i) => {
      out[name] = cells[i] ?? ""
    })
    return out
  })
}
