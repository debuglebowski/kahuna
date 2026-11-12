/** Operator-only content redaction. No dotenv loading, HTTP route or automatic job. */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Client } from "pg"

const marker = "[erased]"
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function redactValue(value: unknown, terms: readonly string[], key = ""): unknown {
  if (typeof value === "string") {
    if (!terms.some((term) => value.includes(term))) return value
    // Never rewrite event tags, foreign keys, actor ids or JSON keys as content.
    if (
      key === "_tag" ||
      /(^id$|Id$|_id$|^actor$|^createdBy$|^assignee$)/.test(key) ||
      uuid.test(value)
    )
      throw new Error("Match in structural/identity value; handle separately")
    return terms.reduce((text, term) => text.split(term).join(marker), value)
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, terms, key))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => {
        if (terms.some((term) => name.includes(term)))
          throw new Error("Match in JSON key; handle separately")
        return [name, redactValue(entry, terms, name)]
      }),
    )
  }
  return value
}

export async function redactHistory(
  client: Client,
  orgId: string,
  terms: readonly string[],
  apply?: string,
) {
  if (!uuid.test(orgId)) throw new Error("An explicit organisation UUID is required")
  if (
    !terms.length ||
    terms.some(
      (term) =>
        typeof term !== "string" ||
        term.trim() !== term ||
        term.length < 4 ||
        marker.includes(term) ||
        uuid.test(term),
    )
  )
    throw new Error("Use full, exact content values of at least four characters; no identifiers")
  const ordered = [...new Set(terms)].sort((a, b) => b.length - a.length || a.localeCompare(b))
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL statement_timeout = '60s'")
    // Pause event writes during apply. A fresh preview/digest is required if anything changed.
    if (apply) await client.query("LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE")
    // Fail closed if current records, mirrors, metadata or identities still contain
    // these values. Clear those through their supported app workflow first.
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id' ORDER BY table_name",
    )
    const needles = ordered.map((term) => JSON.stringify(term).slice(1, -1))
    for (const { table_name: table } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Unsupported table name")
      const document = table === "events" ? "to_jsonb(t) - 'payload'" : "to_jsonb(t)"
      const result = await client.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "${table}" t CROSS JOIN unnest($2::text[]) needle WHERE t.org_id = $1 AND strpos((${document})::text, needle) > 0) AS found`,
        [orgId, needles],
      )
      if (result.rows[0]?.found)
        throw new Error("Matching current data or identity metadata remains; handle separately")
    }
    const { rows } = await client.query<{ id: string; payload: unknown }>(
      "SELECT id::text, payload FROM events WHERE org_id = $1 ORDER BY id LIMIT 100001",
      [orgId],
    )
    if (rows.length > 100000) throw new Error("Scope too large for this manual tool")
    const changed = rows.flatMap((row) => {
      const next = redactValue(row.payload, ordered)
      return digest(next) === digest(row.payload)
        ? []
        : [{ id: row.id, before: digest(row.payload), next }]
    })
    const planDigest = digest({ orgId, terms: ordered, changed })
    if (apply && apply !== planDigest) throw new Error("Preview changed; review a fresh dry run")
    if (apply) {
      for (const row of changed) {
        const result = await client.query(
          "UPDATE events SET payload = $1::jsonb WHERE org_id = $2 AND id = $3",
          [JSON.stringify(row.next), orgId, row.id],
        )
        if (result.rowCount !== 1) throw new Error("Event changed; transaction aborted")
      }
      await client.query("COMMIT")
    } else {
      await client.query("ROLLBACK")
    }
    // Counts/ids only. No payloads, names, addresses or database credentials in receipts.
    return {
      mode: apply ? "applied" : "preview",
      orgId,
      eventIds: changed.map((row) => row.id),
      changedEvents: changed.length,
      planDigest,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

async function main() {
  // Input file is private: { orgId, terms: [fullName, email, ...] }. No values on argv.
  const [inputPath, ...options] = process.argv.slice(2)
  if (
    !inputPath ||
    options.some((arg) => !arg.startsWith("--apply=") && !arg.startsWith("--database="))
  )
    throw new Error(
      "Usage: bun scripts/redact-history.ts private-input.json --database=NAME [--apply=DIGEST]",
    )
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL must be explicitly provided")
  const database = options.find((arg) => arg.startsWith("--database="))?.slice(11)
  if (!database || decodeURIComponent(new URL(url).pathname.slice(1)) !== database)
    throw new Error("Explicit database name must match DATABASE_URL")
  const input = JSON.parse(await readFile(inputPath, "utf8"))
  if (typeof input.orgId !== "string" || !Array.isArray(input.terms))
    throw new Error("Invalid input file")
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    console.log(
      JSON.stringify(
        await redactHistory(
          client,
          input.orgId,
          input.terms,
          options.find((arg) => arg.startsWith("--apply="))?.slice(8),
        ),
      ),
    )
  } finally {
    await client.end()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // Parser/pg errors can include private input or query values.
    console.error(
      "Redaction failed or outcome unconfirmed. Re-run preview before retry; no values logged.",
    )
    process.exitCode = 1
  }
}
