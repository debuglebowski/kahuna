import "../server/env"

import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { provisionVerifyIdentity } from "./verify-session"

/**
 * End-to-end driver for the `km` CLI, against a LIVE server.
 *
 * Runs the BUILT BUNDLE with plain `node`, not the TypeScript source with Bun —
 * that is the artifact users get, and the difference is not cosmetic: syntax
 * that emits (parameter properties, enums) typechecks and then fails only under
 * Node. Running the source here would test something nobody installs.
 *
 * Each run provisions its own throwaway account and org through the same
 * `provisionVerifyIdentity` every other verify driver uses, so it never touches
 * existing data, and writes its config to a temp XDG dir so it cannot disturb
 * the operator's real profiles.
 *
 *   bun run --cwd packages/cli build && bun scripts/verify-cli.ts
 */
const exec = promisify(execFile)

const API = process.env.API_URL ?? "http://localhost:3100"
const CLI = path.resolve(import.meta.dirname, "../../cli/dist/index.js")

let passed = 0
let failed = 0
const configHome = mkdtempSync(path.join(tmpdir(), "km-verify-"))

interface Result {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the CLI and capture everything a script would see. */
const km = async (...args: ReadonlyArray<string>): Promise<Result> => {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: configHome, KM_HOST: API },
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${detail ? `\n      ${detail.replaceAll("\n", "\n      ")}` : ""}`)
  }
}

const main = async (): Promise<void> => {
  console.log(`verify-cli — ${API}\n`)

  // Fail early and clearly if the bundle was never built: an ENOENT from `node`
  // deep inside a later assertion reads like a CLI bug.
  const probe = await km("help")
  if (probe.code !== 0 || !probe.stdout.includes("Kingsmaker")) {
    console.error(`Cannot run ${CLI}. Build it first: bun run cli:build`)
    process.exit(2)
  }

  const id = await provisionVerifyIdentity("cli")
  console.log(`identity: ${id.email}\n`)

  console.log("auth")
  check("health before sign-in", (await km("system", "health")).code === 0)
  const whoamiBefore = await km("auth", "whoami")
  check("whoami exits 3 when signed out", whoamiBefore.code === 3, whoamiBefore.stderr)

  const login = await km("auth", "login", "--email", id.email, "--password", id.password)
  check("login succeeds", login.code === 0, login.stderr)
  const whoami = await km("auth", "whoami", "--json")
  check("whoami succeeds once signed in", whoami.code === 0, whoami.stderr)

  console.log("\nrecords")
  const list = await km("record", "list", "company", "--json")
  check("record list <concept>", list.code === 0, list.stderr)

  const created = await km(
    "record",
    "create",
    "company",
    "--field",
    "name=Verify Industries",
    "--json",
  )
  check("record create", created.code === 0, created.stderr)
  const recordId = created.code === 0 ? (JSON.parse(created.stdout) as { id: string }).id : ""
  check("create returns an id", Boolean(recordId), created.stdout)

  if (recordId) {
    const got = await km("record", "get", recordId, "--json")
    const row = got.code === 0 ? (JSON.parse(got.stdout) as Record<string, unknown>) : {}
    check("record get returns the value just written", row.name === "Verify Industries", got.stdout)

    const updated = await km(
      "record",
      "update",
      recordId,
      "--field",
      "name=Verify Holdings",
      "--json",
    )
    check("record update (read-then-write, expectedVersion)", updated.code === 0, updated.stderr)
    const after = await km("record", "get", recordId, "--json")
    check(
      "the update is visible on re-read",
      (JSON.parse(after.stdout) as { name?: string }).name === "Verify Holdings",
      after.stdout,
    )

    const search = await km("record", "search", "company", "Verify", "--json")
    check(
      "record search finds it",
      search.code === 0 && search.stdout.includes(recordId),
      search.stderr || search.stdout,
    )

    const dry = await km("record", "delete", recordId, "--dry-run")
    check("record delete --dry-run writes nothing", dry.code === 0, dry.stderr)
    const stillThere = await km("record", "get", recordId, "--json")
    check("record survives the dry run", stillThere.code === 0)

    const unconfirmed = await km("record", "delete", recordId)
    check(
      "record delete without --yes REFUSES (exit 2)",
      unconfirmed.code === 2,
      unconfirmed.stderr,
    )

    check("record archive", (await km("record", "archive", recordId)).code === 0)
    check("record restore", (await km("record", "restore", recordId)).code === 0)

    const deleted = await km("record", "delete", recordId, "--yes")
    check("record delete --yes purges", deleted.code === 0, deleted.stderr)
    const gone = await km("record", "get", recordId, "--json")
    check("the record is gone afterwards", gone.code !== 0, gone.stdout)
  }

  console.log("\nschema")
  const stamp = Date.now()
  const conceptName = `CliVendor${stamp}`
  const madeConcept = await km(
    "concept",
    "create",
    conceptName,
    "--description",
    "made by verify-cli",
  )
  check("concept create", madeConcept.code === 0, madeConcept.stderr)

  const slug = conceptName.toLowerCase()
  const addedField = await km("concept", "field", "add", slug, "--name", "title", "--kind", "text")
  check("concept field add", addedField.code === 0, addedField.stderr)
  const addedEnum = await km(
    "concept",
    "field",
    "add",
    slug,
    "--name",
    "stage",
    "--kind",
    "enum",
    "--options",
    "new,won,lost",
  )
  check("concept field add --kind enum --options", addedEnum.code === 0, addedEnum.stderr)

  const relNoTarget = await km(
    "concept",
    "field",
    "add",
    slug,
    "--name",
    "owner",
    "--kind",
    "relation",
  )
  check("a relation field without --target is refused", relNoTarget.code === 2, relNoTarget.stderr)
  const badKind = await km("concept", "field", "add", slug, "--name", "x", "--kind", "wormhole")
  check(
    "an unknown field kind lists the real ones",
    badKind.code === 2 && badKind.stderr.includes("richtext"),
    badKind.stderr,
  )

  const titled = await km("concept", "update", slug, "--title-field", "title")
  check("concept update --title-field", titled.code === 0, titled.stderr)

  const shown = await km("concept", "get", slug, "--json")
  const conceptJson = shown.code === 0 ? JSON.parse(shown.stdout) : {}
  check(
    "concept get reports the fields just added",
    Array.isArray(conceptJson.fields) && conceptJson.fields.length === 2,
    shown.stdout.slice(0, 200),
  )

  // A record in the new concept proves the schema is real, and that the title
  // field is what the label resolves through.
  const rec = await km("record", "create", slug, "--field", "title=First", "--json")
  check("a record can be created in the new concept", rec.code === 0, rec.stderr)
  const recRow = rec.code === 0 ? JSON.parse(rec.stdout) : {}
  check("the title field becomes the record's label", recRow.label === "First", rec.stdout)

  const reordered = await km("concept", "field", "reorder", slug, "stage")
  check("concept field reorder", reordered.code === 0, reordered.stderr)
  const afterOrder = await km("concept", "field", "list", slug, "--json")
  check(
    "the named field moved to the front, the rest kept their order",
    JSON.parse(afterOrder.stdout)[0]?.name === "stage",
    afterOrder.stdout.slice(0, 200),
  )

  const labelName = `cli-label-${stamp}`
  check("label create", (await km("label", "create", labelName)).code === 0)
  const labels = await km("label", "list", "--json")
  check("label list shows it", labels.stdout.includes(labelName), labels.stdout.slice(0, 200))
  check("label archive", (await km("label", "archive", labelName)).code === 0)
  check("label delete --yes", (await km("label", "delete", labelName, "--yes")).code === 0)

  const conceptUnconfirmed = await km("concept", "delete", slug)
  check(
    "concept delete without --yes REFUSES",
    conceptUnconfirmed.code === 2,
    conceptUnconfirmed.stderr,
  )

  // BLOCK, NOT CASCADE. The concept still holds the record created above, and
  // the server refuses rather than taking it with it — the CLI must say what is
  // in the way and what to do, not print a bare CONCEPT_IN_USE.
  const inUse = await km("concept", "delete", slug, "--yes")
  check(
    "deleting a concept that still has records is refused (exit 6) and explained",
    inUse.code === 6 &&
      inUse.stderr.includes("still has records") &&
      inUse.stderr.includes("archive"),
    inUse.stderr,
  )

  if (recRow.id) await km("record", "delete", String(recRow.id), "--yes")
  check(
    "concept delete --yes purges once it is empty",
    (await km("concept", "delete", slug, "--yes")).code === 0,
  )

  console.log("\nerrors and exit codes")
  const badConcept = await km("record", "list", "nonexistent-concept")
  check("unknown concept exits 5", badConcept.code === 5, badConcept.stderr)

  // "compan" matches Company, CompanyContact and CompanyNote in a seeded org,
  // so this asserts the REFUSAL: guessing one would silently list the wrong
  // concept's records.
  const ambiguous = await km("record", "list", "compan")
  check(
    "an ambiguous prefix is refused with the candidates named",
    ambiguous.code === 2 &&
      ambiguous.stderr.includes("companycontact") &&
      ambiguous.stderr.includes("matches 3"),
    ambiguous.stderr,
  )
  const exact = await km("record", "list", "company", "--json")
  check("an exact slug still resolves past the ambiguity", exact.code === 0, exact.stderr)

  const badField = await km("record", "create", "company", "--field", "nope=x")
  check("unknown field exits 5", badField.code === 5, badField.stderr)

  const badFlag = await km("record", "list", "company", "--jsno")
  check("a typo'd flag is a usage error, not silently ignored", badFlag.code === 2, badFlag.stderr)

  const unknown = await km("record", "frobnicate")
  check("unknown command exits 2", unknown.code === 2, unknown.stderr)

  console.log("\noutput discipline")
  const json = await km("record", "list", "company", "--json")
  check(
    "--json puts ONLY data on stdout",
    (() => {
      try {
        JSON.parse(json.stdout)
        return true
      } catch {
        return false
      }
    })(),
    json.stdout.slice(0, 200),
  )

  const csv = await km("record", "list", "company", "--csv")
  check(
    "--csv emits a header row",
    csv.code === 0 && (csv.stdout.split("\n")[0]?.includes("id") ?? false),
    csv.stdout.slice(0, 120),
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  rmSync(configHome, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  rmSync(configHome, { recursive: true, force: true })
  console.error(e)
  process.exit(1)
})
