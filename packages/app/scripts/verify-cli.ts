import "../server/env"

import { execFile, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
 * the operator's own configuration.
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

  console.log("\nbulk in and out")
  const bulkName = `CliBulk${stamp}`
  const bulkSlug = bulkName.toLowerCase()
  await km("concept", "create", bulkName)
  await km("concept", "field", "add", bulkSlug, "--name", "code", "--kind", "text")
  await km("concept", "field", "add", bulkSlug, "--name", "seats", "--kind", "number")
  await km("concept", "update", bulkSlug, "--title-field", "code")

  const csvPath = path.join(configHome, "import.csv")
  // Deliberately awkward data: a comma, a doubled quote, an embedded newline
  // and an empty cell — the cases a naive splitter gets wrong.
  writeFileSync(
    csvPath,
    "code,seats\n" + "A-1,10\n" + '"B, the ""second""",20\n' + '"C\nmultiline",\n',
  )

  const dryImport = await km("record", "import", bulkSlug, csvPath, "--dry-run")
  check(
    "import --dry-run reports counts and writes nothing",
    dryImport.code === 0 && dryImport.stderr.includes("3 created"),
    dryImport.stderr,
  )
  const afterDry = await km("record", "list", bulkSlug, "--json")
  check(
    "nothing was written by the dry run",
    JSON.parse(afterDry.stdout).length === 0,
    afterDry.stdout,
  )

  const imported = await km("record", "import", bulkSlug, csvPath)
  check("record import creates the rows", imported.code === 0, imported.stderr)
  const listed = JSON.parse((await km("record", "list", bulkSlug, "--json")).stdout) as Array<
    Record<string, unknown>
  >
  check("all three rows landed", listed.length === 3, JSON.stringify(listed).slice(0, 200))
  check(
    "a quoted comma survived the round trip",
    listed.some((r) => r.code === 'B, the "second"'),
    JSON.stringify(listed).slice(0, 300),
  )
  check(
    "an embedded newline survived",
    listed.some((r) => String(r.code).includes("\n")),
    JSON.stringify(listed).slice(0, 300),
  )
  check(
    "a numeric column is a NUMBER, not the string of one",
    listed.some((r) => r.seats === 10),
    JSON.stringify(listed).slice(0, 300),
  )

  // Re-importing with --key must UPDATE, not duplicate.
  writeFileSync(csvPath, "code,seats\nA-1,99\n")
  const reimported = await km("record", "import", bulkSlug, csvPath, "--key", "code")
  check(
    "re-import with --key updates instead of duplicating",
    reimported.code === 0 && reimported.stderr.includes("1 updated"),
    reimported.stderr,
  )
  const afterKey = JSON.parse((await km("record", "list", bulkSlug, "--json")).stdout) as Array<
    Record<string, unknown>
  >
  check("still three records, not four", afterKey.length === 3, String(afterKey.length))
  check(
    "the value was updated",
    afterKey.some((r) => r.seats === 99),
    JSON.stringify(afterKey).slice(0, 200),
  )

  const badHeader = path.join(configHome, "bad.csv")
  writeFileSync(badHeader, "code,nonexistent\nX,1\n")
  const badImport = await km("record", "import", bulkSlug, badHeader)
  check(
    "an unknown column FAILS rather than importing without it",
    badImport.code === 5 && badImport.stderr.includes("nonexistent"),
    badImport.stderr,
  )

  const exported = await km("record", "export", bulkSlug, "--csv")
  check(
    "record export emits the field names as columns",
    exported.code === 0 && exported.stdout.startsWith("id,code,seats"),
    exported.stdout.slice(0, 120),
  )

  const exportAllCsv = await km("record", "export", "--all-concepts", "--csv")
  check(
    "--all-concepts with --csv is refused with a reason",
    exportAllCsv.code === 2 && exportAllCsv.stderr.includes("different columns"),
    exportAllCsv.stderr,
  )
  const exportAll = await km("record", "export", "--all-concepts", "--json")
  check(
    "--all-concepts --json bundles every concept",
    exportAll.code === 0 && Object.keys(JSON.parse(exportAll.stdout)).length > 1,
    exportAll.stdout.slice(0, 120),
  )

  console.log("\ntasks, notes and attachments")
  // The LINEAGE id (`record`), not the version id: annotations attach to the
  // record, and passing the version id is exactly the mistake the column exists
  // to prevent.
  const anchorRecord = (
    JSON.parse((await km("record", "list", bulkSlug, "--json")).stdout) as Array<{
      id: string
      record: string
    }>
  )[0]?.record
  check("a record to hang annotations on", Boolean(anchorRecord))

  const statuses = await km("task", "status", "list", "--json")
  check("task status list", statuses.code === 0, statuses.stderr)
  const firstStatus = (JSON.parse(statuses.stdout) as Array<{ name: string }>)[0]?.name ?? ""

  const madeTask = await km("task", "create", "Ship the CLI", "--record", String(anchorRecord))
  check("task create on a record", madeTask.code === 0, madeTask.stderr)
  const tasks = JSON.parse(
    (await km("task", "list", "--record", String(anchorRecord), "--json")).stdout,
  ) as Array<Record<string, unknown>>
  check("task list --record finds it", tasks.length === 1, JSON.stringify(tasks).slice(0, 200))
  const taskId = String(tasks[0]?.id ?? "")

  if (taskId && firstStatus) {
    // Four procedures behind one command, each bumping expectedVersion — the
    // case that fails if they are batched instead of re-read between.
    const multi = await km(
      "task",
      "update",
      taskId,
      "--title",
      "Ship it",
      "--status",
      firstStatus,
      "--assignee",
      "none",
    )
    check("task update changes title AND status in one command", multi.code === 0, multi.stderr)
    const after = JSON.parse(
      (await km("task", "list", "--record", String(anchorRecord), "--json")).stdout,
    ) as Array<Record<string, unknown>>
    check("the title changed", after[0]?.title === "Ship it", JSON.stringify(after).slice(0, 200))
    check(
      "the status changed",
      after[0]?.status === firstStatus,
      JSON.stringify(after).slice(0, 200),
    )

    check("task archive", (await km("task", "archive", taskId)).code === 0)
    check("task restore", (await km("task", "restore", taskId)).code === 0)
    check("task delete --yes", (await km("task", "delete", taskId, "--yes")).code === 0)
  }

  const madeNote = await km(
    "note",
    "create",
    "A note from the CLI",
    "--record",
    String(anchorRecord),
  )
  check("note create", madeNote.code === 0, madeNote.stderr)
  const notes = JSON.parse(
    (await km("note", "list", "--record", String(anchorRecord), "--json")).stdout,
  ) as Array<Record<string, unknown>>
  check("note list --record finds it", notes.length === 1, JSON.stringify(notes).slice(0, 200))
  const noteListNoRecord = await km("note", "list")
  check(
    "note list without a record explains WHY it cannot",
    noteListNoRecord.code === 2 && noteListNoRecord.stderr.includes("subject"),
    noteListNoRecord.stderr,
  )

  // Attachments: the bytes must survive a round trip, which is the only thing
  // that proves multipart up and streamed down actually agree.
  const uploadPath = path.join(configHome, "attach.txt")
  const payload = `bytes ${stamp}\nsecond line\n`
  writeFileSync(uploadPath, payload)
  const uploaded = await km("attachment", "upload", uploadPath, "--record", String(anchorRecord))
  check("attachment upload", uploaded.code === 0, uploaded.stderr)
  const bothOwners = await km(
    "attachment",
    "upload",
    uploadPath,
    "--record",
    String(anchorRecord),
    "--bucket",
    "x",
  )
  check("--record AND --bucket together is refused", bothOwners.code === 2, bothOwners.stderr)

  const files = JSON.parse(
    (await km("attachment", "list", "--record", String(anchorRecord), "--json")).stdout,
  ) as Array<Record<string, unknown>>
  check("attachment list shows it", files.length === 1, JSON.stringify(files).slice(0, 200))
  const fileId = String(files[0]?.id ?? "")
  check(
    "the size is reported",
    Number(files[0]?.size) === Buffer.byteLength(payload),
    String(files[0]?.size),
  )

  if (fileId) {
    const outPath = path.join(configHome, "downloaded.txt")
    const down = await km("attachment", "download", fileId, "--out", outPath)
    check("attachment download", down.code === 0, down.stderr)
    check(
      "the downloaded bytes are IDENTICAL to what was uploaded",
      readFileSync(outPath, "utf8") === payload,
      readFileSync(outPath, "utf8").slice(0, 80),
    )
    check("attachment delete --yes", (await km("attachment", "delete", fileId, "--yes")).code === 0)
  }

  console.log("\naccess, organization, dashboards, automations")
  const whole = await km("access", "check", "--json")
  check("access check with no question gives the whole picture", whole.code === 0, whole.stderr)
  const picture = whole.code === 0 ? JSON.parse(whole.stdout) : {}
  check(
    "it reports ownership and the roles held",
    "isOwner" in picture && "roles" in picture,
    whole.stdout.slice(0, 160),
  )

  // The identity provisioned for this run owns its org, so the answer is known.
  const explained = await km(
    "access",
    "check",
    "--action",
    "configure",
    "--resource",
    "org",
    "--json",
  )
  const trace = explained.code === 0 ? JSON.parse(explained.stdout) : {}
  check(
    "access check --action --resource answers one question",
    explained.code === 0,
    explained.stderr,
  )
  check(
    "the owner is allowed to configure the org",
    trace.outcome === true,
    explained.stdout.slice(0, 200),
  )
  check(
    "the answer comes with an ordered layer trace",
    Array.isArray(trace.layers) && trace.layers.length > 0,
    explained.stdout.slice(0, 300),
  )
  const table = await km("access", "check", "--action", "configure", "--resource", "org")
  check(
    "the trace renders as a table with a decided marker",
    table.stdout.includes("decided") || table.stdout.includes("ALLOWED"),
    table.stdout.slice(0, 300),
  )

  const badAction = await km("access", "check", "--action", "levitate", "--resource", "org")
  check(
    "an unknown action lists the real ones",
    badAction.code === 2 && badAction.stderr.includes("configure"),
    badAction.stderr,
  )
  const halfQuestion = await km("access", "check", "--action", "view")
  check("--action without --resource is refused", halfQuestion.code === 2, halfQuestion.stderr)

  const roles = await km("access", "role", "list", "--json")
  check("access role list", roles.code === 0, roles.stderr)
  const roleNames = (JSON.parse(roles.stdout) as Array<{ name: string }>).map((r) => r.name)
  check("the seeded roles are there", roleNames.length > 0, roleNames.join(","))
  const holders = await km("access", "role", "holders", roleNames[0] ?? "")
  check("access role holders", holders.code === 0, holders.stderr)

  const members = await km("organization", "member", "list", "--json")
  check("organization member list", members.code === 0, members.stderr)
  const noSuchAccount = await km("organization", "member", "add", `ghost-${stamp}@example.test`)
  check(
    "adding an unprovisioned account explains that sign-up is closed",
    noSuchAccount.code === 5 && noSuchAccount.stderr.includes("provisioned"),
    noSuchAccount.stderr,
  )

  const dashboards = await km("dashboard", "list", "--json")
  check("dashboard list", dashboards.code === 0, dashboards.stderr)
  const dashNames = JSON.parse(dashboards.stdout) as Array<{ name: string }>

  const dashCreated = await km("dashboard", "create", `CLI Test ${stamp}`)
  check("dashboard create (empty)", dashCreated.code === 0, dashCreated.stderr)

  const groupAdd = await km(
    "dashboard",
    "group",
    "add",
    `CLI Test ${stamp}`,
    "--direction",
    "col",
    "--label",
    "Section",
  )
  check("dashboard group add", groupAdd.code === 0, groupAdd.stderr)

  const widgetAdd = await km(
    "dashboard",
    "widget",
    "add",
    `CLI Test ${stamp}`,
    "--type",
    "note",
    "--parent",
    "Section",
    "--title",
    "Hello",
  )
  check("dashboard widget add", widgetAdd.code === 0, widgetAdd.stderr)

  const widgetList = await km("dashboard", "widget", "list", `CLI Test ${stamp}`, "--json")
  check("dashboard widget list", widgetList.code === 0, widgetList.stderr)
  const nodes = JSON.parse(widgetList.stdout) as Array<{ type: string; id: string }>
  const widget = nodes.find((n) => n.type === "note")
  check("the added widget is listed", widget !== undefined, widgetList.stdout)

  if (widget) {
    const widgetGet = await km(
      "dashboard",
      "widget",
      "get",
      `CLI Test ${stamp}`,
      widget.id,
      "--json",
    )
    check("dashboard widget get", widgetGet.code === 0, widgetGet.stderr)

    const widgetSet = await km(
      "dashboard",
      "widget",
      "set",
      `CLI Test ${stamp}`,
      widget.id,
      "--set",
      "padding=0",
    )
    check("dashboard widget set", widgetSet.code === 0, widgetSet.stderr)

    const widgetRemove = await km("dashboard", "widget", "remove", `CLI Test ${stamp}`, widget.id)
    check("dashboard widget remove", widgetRemove.code === 0, widgetRemove.stderr)
  }

  if (dashNames[0]) {
    const duplicated = await km(
      "dashboard",
      "create",
      `Clone ${stamp}`,
      "--from",
      dashNames[0].name,
    )
    check("dashboard create --from", duplicated.code === 0, duplicated.stderr)
    const after = JSON.parse((await km("dashboard", "list", "--json")).stdout) as Array<{
      name: string
    }>
    check(
      "the clone is listed",
      after.some((d) => d.name === `Clone ${stamp}`),
      String(after.length),
    )
    check(
      "dashboard delete --yes (clone)",
      (await km("dashboard", "delete", `Clone ${stamp}`, "--yes")).code === 0,
    )
  }

  const renamed = await km(
    "dashboard",
    "update",
    `CLI Test ${stamp}`,
    "--name",
    `CLI Test Renamed ${stamp}`,
  )
  check("dashboard update", renamed.code === 0, renamed.stderr)
  check(
    "dashboard delete --yes (renamed)",
    (await km("dashboard", "delete", `CLI Test Renamed ${stamp}`, "--yes")).code === 0,
  )

  const noName = await km("dashboard", "create")
  check("dashboard create with no name is refused", noName.code === 2, noName.stderr)

  const automations = await km("automation", "list", "--json")
  check("automation list", automations.code === 0, automations.stderr)

  console.log("\nbrowser login (device flow)")
  // The whole flow WITHOUT a browser: start `km auth login --browser`, read the
  // link it prints, and open it the way a signed-in browser would. Opening it IS
  // the approval — there is nothing to type — so this is the real sequence, and
  // the one that works over ssh.
  const blHome = path.join(configHome, "browser")
  const child = spawn("node", [CLI, "auth", "login", "--browser"], {
    // KM_NO_BROWSER: this driver runs the real command, and without it every run
    // opens a tab on the machine running the tests.
    env: { ...process.env, XDG_CONFIG_HOME: blHome, KM_HOST: API, KM_NO_BROWSER: "1" },
  })
  let stderrBuf = ""
  child.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString()
  })

  const link = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no link printed")), 20_000)
    const poll = setInterval(() => {
      const m = /(https?:\/\/\S*\/api\/cli\/device\?code=\S+)/.exec(stderrBuf)
      if (m?.[1]) {
        clearInterval(poll)
        clearTimeout(deadline)
        resolve(m[1])
      }
    }, 100)
  })
  check(
    "--browser prints one link, and nothing to type",
    Boolean(link) && !/Your code/.test(stderrBuf),
    stderrBuf.slice(0, 200),
  )
  check(
    "NOTHING is redirected to localhost — the point of the device flow",
    !stderrBuf.includes("127.0.0.1"),
    stderrBuf.slice(0, 200),
  )

  const anon = await fetch(link, { redirect: "manual" })
  check(
    "an unauthenticated visit is sent to sign in, keeping the code",
    anon.status === 302 &&
      decodeURIComponent(anon.headers.get("location") ?? "").includes("/api/cli/device?code="),
    String(anon.headers.get("location")),
  )

  const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify({ email: id.email, password: id.password }),
  })
  const browserCookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")

  const stale = await fetch(`${API}/api/cli/device?code=ZZZZ-ZZZZ`, {
    headers: { cookie: browserCookie },
  })
  check("a signed-in visit with a dead code is refused", stale.status === 400, String(stale.status))

  // Opening the link approves it. No form, no code entry.
  const approved = await fetch(link, { headers: { cookie: browserCookie } })
  check("opening the link IS the approval", approved.status === 200, String(approved.status))
  check("the page says so", (await approved.text()).includes("Signed in"), "")

  const blExit = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)))
  check("the CLI notices and exits 0", blExit === 0, stderrBuf.slice(-300))

  const afterBrowser = await exec("node", [CLI, "concept", "list", "--json"], {
    env: { ...process.env, XDG_CONFIG_HOME: blHome, KM_HOST: API },
  }).catch((e: unknown) => ({ stdout: "", stderr: String(e) }))
  check(
    "the stored credential authenticates a later command",
    afterBrowser.stdout.trim().startsWith("["),
    (afterBrowser.stdout || afterBrowser.stderr).slice(0, 200),
  )

  const replay = await fetch(link, { headers: { cookie: browserCookie } })
  check("the link cannot be used twice", replay.status === 400, String(replay.status))

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
