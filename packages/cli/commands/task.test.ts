import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `task list|create|update` against a fake deployment: the RPC client and the
 * BetterAuth member directory are both stubbed, and every payload the command
 * sends is recorded. What is asserted is the WIRE — the ids the server receives
 * — because a name that reaches the server unresolved fails nowhere visible.
 */
const calls = vi.hoisted(() => [] as Array<{ proc: string; payload: unknown }>)
const state = vi.hoisted(() => ({ tasks: [] as Array<Record<string, unknown>> }))

vi.mock("../transport.ts", () => {
  const reply: Record<string, (p: never) => unknown> = {
    listTaskStatuses: () => [
      { id: "s-todo", name: "Todo", category: "todo", isDefault: true },
      { id: "s-done", name: "Done", category: "done", isDefault: false },
    ],
    listTaskPriorities: () => [
      { id: "p-high", name: "High", color: null, position: 0 },
      { id: "p-med", name: "Medium", color: null, position: 1 },
    ],
    listLabels: () => [
      { id: "l-vendor", name: "Vendor" },
      { id: "l-legal", name: "Legal" },
      { id: "l-ops", name: "Ops" },
    ],
    listTasks: () => state.tasks,
  }
  const client = new Proxy(
    {},
    {
      get: (_, proc: string) => (payload: unknown) => {
        calls.push({ proc, payload })
        const r = reply[proc]
        return Effect.succeed(r ? r(payload as never) : { id: "t-new", title: "x", version: 2 })
      },
    },
  )
  return {
    makeRuntime: () => ({
      call: (f: (c: unknown) => Effect.Effect<unknown>) => Effect.runPromise(f(client)),
      dispose: async () => undefined,
    }),
  }
})

vi.mock("../rest.ts", () => ({
  orgMembers: async () => [
    { userId: "u-anna", name: "Anna Berg", email: "anna@normain.com" },
    { userId: "u-bo", name: "Bo Ek", email: "bo@normain.com" },
  ],
  sessionUserId: async () => "u-me",
}))

const { EXIT } = await import("../errors.ts")
const { run } = await import("../index.ts")
const { readDescription } = await import("./task.ts")

const capture = async (argv: ReadonlyArray<string>) => {
  let out = ""
  let err = ""
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c)
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c)
    return true
  })
  const code = await run(argv)
  vi.restoreAllMocks()
  return { code, out, err }
}

const sent = (proc: string) => calls.filter((c) => c.proc === proc).map((c) => c.payload)

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  subjectId: null,
  title: "Review vendor",
  description: null,
  statusId: "s-todo",
  priorityId: null,
  labelIds: [],
  assignee: null,
  dueAt: null,
  snoozedUntil: null,
  version: 1,
  ...over,
})

describe("task commands", () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kahuna-task-"))
    mkdirSync(path.join(dir, "kahuna"))
    writeFileSync(
      path.join(dir, "kahuna", "config.json"),
      JSON.stringify({ host: "https://kahuna.example.com", cookie: "c" }),
    )
    process.env.XDG_CONFIG_HOME = dir
    delete process.env.KAHUNA_HOST
    calls.length = 0
    state.tasks = [task()]
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(dir, { recursive: true, force: true })
  })

  describe("create", () => {
    it("sends priority, labels, description and assignee as ids", async () => {
      const md = path.join(dir, "desc.md")
      writeFileSync(md, "# Scope\n\nCheck the **contract**.\n")
      const { code, err } = await capture([
        "task",
        "create",
        "Review vendor",
        "--priority",
        "high",
        "--label",
        "Vendor",
        "--label",
        "legal",
        "--description",
        `@${md}`,
        "--assignee",
        "anna@normain.com",
      ])
      expect(err).toContain("Created task")
      expect(code).toBe(EXIT.ok)
      const [payload] = sent("createTask") as Array<Record<string, unknown>>
      expect(payload).toMatchObject({
        title: "Review vendor",
        priorityId: "p-high",
        labelIds: ["l-vendor", "l-legal"],
        assignee: "u-anna",
        subjectId: null,
      })
      expect((payload?.description as { text: string } | undefined)?.text).toBe(
        "Scope Check the contract.",
      )
    })

    it("an unknown priority fails before anything is written, naming the options", async () => {
      const { code, err } = await capture(["task", "create", "x", "--priority", "urgent"])
      expect(code).toBe(EXIT.notFound)
      expect(err).toContain('No priority named "urgent"')
      expect(err).toContain("High, Medium")
      expect(sent("createTask")).toHaveLength(0)
    })

    it("refuses an assignee that is not a member", async () => {
      const { code, err } = await capture(["task", "create", "x", "--assignee", "zed@x.com"])
      expect(code).toBe(EXIT.notFound)
      expect(err).toContain('No member matches "zed@x.com"')
      expect(sent("createTask")).toHaveLength(0)
    })

    it("--assignee me is the signed-in user", async () => {
      await capture(["task", "create", "x", "--assignee", "me"])
      expect(sent("createTask")[0]).toMatchObject({ assignee: "u-me" })
    })
  })

  describe("update", () => {
    it("priority, description and labels go in ONE updateTask call", async () => {
      const { code } = await capture([
        "task",
        "update",
        "t1",
        "--priority",
        "Medium",
        "--description",
        "plain text",
        "--label",
        "ops",
      ])
      expect(code).toBe(EXIT.ok)
      const updates = sent("updateTask") as Array<Record<string, unknown>>
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        id: "t1",
        expectedVersion: 1,
        priorityId: "p-med",
        labelIds: ["l-ops"],
      })
      expect((updates[0]?.description as { text: string } | undefined)?.text).toBe("plain text")
    })

    it("--add-label / --remove-label edit the current set", async () => {
      state.tasks = [task({ labelIds: ["l-vendor", "l-legal"] })]
      await capture(["task", "update", "t1", "--add-label", "Ops", "--remove-label", "Legal"])
      expect(sent("updateTask")[0]).toMatchObject({ labelIds: ["l-vendor", "l-ops"] })
    })

    it("none clears priority, labels, description and assignee", async () => {
      state.tasks = [task({ priorityId: "p-high", labelIds: ["l-ops"], assignee: "u-bo" })]
      await capture([
        "task",
        "update",
        "t1",
        "--priority",
        "none",
        "--label",
        "none",
        "--description",
        "none",
        "--assignee",
        "none",
      ])
      expect(sent("updateTask")[0]).toMatchObject({
        priorityId: null,
        labelIds: [],
        description: null,
      })
      expect(sent("assignTask")[0]).toMatchObject({ assignee: null })
    })

    it("untouched fields are not sent", async () => {
      await capture(["task", "update", "t1", "--title", "New"])
      const [u] = sent("updateTask") as Array<Record<string, unknown>>
      expect(u?.priorityId).toBeUndefined()
      expect(u?.labelIds).toBeUndefined()
      expect(u?.description).toBeUndefined()
    })

    it("--label cannot be combined with --add-label", async () => {
      const { code } = await capture([
        "task",
        "update",
        "t1",
        "--label",
        "Ops",
        "--add-label",
        "Legal",
      ])
      expect(code).toBe(EXIT.usage)
      expect(sent("updateTask")).toHaveLength(0)
    })

    it("a bad label fails before the title is written", async () => {
      const { code } = await capture(["task", "update", "t1", "--title", "New", "--label", "nope"])
      expect(code).toBe(EXIT.notFound)
      expect(sent("updateTask")).toHaveLength(0)
    })
  })

  describe("list", () => {
    it("--assignee by email filters by the member's user id", async () => {
      await capture(["task", "list", "--assignee", "bo@normain.com"])
      expect(sent("listTasks")[0]).toMatchObject({ assignee: "u-bo" })
    })

    it("--assignee with a raw user id passes it through", async () => {
      await capture(["task", "list", "--assignee", "u-anna"])
      expect(sent("listTasks")[0]).toMatchObject({ assignee: "u-anna" })
    })

    it("a non-member value still filters, with a warning saying why it may be empty", async () => {
      const { err } = await capture(["task", "list", "--assignee", "u-gone"])
      expect(sent("listTasks")[0]).toMatchObject({ assignee: "u-gone" })
      expect(err).toContain('No member matches "u-gone"')
    })

    it("shows priority and labels; JSON carries the description", async () => {
      state.tasks = [
        task({
          priorityId: "p-high",
          labelIds: ["l-vendor", "l-ops"],
          description: { doc: {}, text: "Check the contract." },
        }),
      ]
      const table = await capture(["task", "list"])
      expect(table.out).toMatch(/PRIORITY\s+LABELS/)
      expect(table.out).toMatch(/High\s+Vendor, Ops/)
      expect(table.out).not.toContain("Check the contract.")

      const json = await capture(["task", "list", "--json"])
      expect(JSON.parse(json.out)[0]).toMatchObject({
        priority: "High",
        labels: "Vendor, Ops",
        description: "Check the contract.",
      })
    })
  })
})

describe("readDescription", () => {
  const files: Record<string, string> = { "d.md": "- a\n- b\n\n" }
  const read = (p: string) => {
    const f = files[p]
    if (f === undefined) throw new Error("ENOENT")
    return f
  }

  it("markdown → rich text; @file reads; @@ is a literal @", () => {
    expect(readDescription("**hi**", read)?.text).toBe("hi")
    const list = readDescription("@d.md", read)
    expect((list?.doc as { content: Array<{ type: string }> } | undefined)?.content[0]?.type).toBe(
      "bulletList",
    )
    expect(readDescription("@@handle", read)?.text).toBe("@handle")
  })

  it("none / empty clears; a missing file is an error", () => {
    expect(readDescription("none", read)).toBeNull()
    expect(readDescription("", read)).toBeNull()
    expect(() => readDescription("@missing.md", read)).toThrow(/Cannot read missing.md/)
  })
})
