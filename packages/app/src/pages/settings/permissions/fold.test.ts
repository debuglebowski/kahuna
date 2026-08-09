import { describe, expect, it } from "vitest"
import {
  ALL_ROW,
  type Answerable,
  type FoldRule,
  type Group,
  key,
  readAnswers,
  sameAnswers,
  writeGroups,
} from "./fold"
import type { CellState } from "./StateGroup"

/**
 * The fold, tested directly rather than through a component.
 *
 * This is the half of the permissions editor where a mistake is silent: a rendering
 * bug you see, a fold bug writes the wrong rule and looks fine. Successor to
 * `PermissionMatrix.test.ts`, which covered the same ground for the grid — every
 * case there is carried over, plus the ones the grid could not have: the blanket
 * row, and the passthrough that keeps a save from destroying what the pane cannot
 * draw.
 */

const rule = (over: Partial<FoldRule> = {}): FoldRule => ({
  effect: over.effect ?? "allow",
  actions: over.actions ?? ["view"],
  resourceType: over.resourceType ?? "concept",
  resourceId: over.resourceId ?? null,
  conceptId: over.conceptId ?? null,
  condition: over.condition ?? null,
})

const CONCEPT: ReadonlyArray<Group> = [{ resourceType: "concept" }]
const ANSWERABLE: ReadonlyArray<Answerable> = [
  { resourceType: "concept", action: "view" },
  { resourceType: "concept", action: "configure" },
]
const ROWS = ["c1", "c2"]

const read = (rules: ReadonlyArray<FoldRule>) => readAnswers(rules, CONCEPT, ANSWERABLE)
const at = (answers: ReadonlyMap<string, CellState>, row: string, action: string) =>
  answers.get(key(row, "concept", action))

describe("readAnswers", () => {
  it("no rules at all: every answer is absent (the caller defaults it to inherit)", () => {
    expect(read([]).answers.size).toBe(0)
  })

  it("a targeted allow sets that answer, and only that one", () => {
    const { answers } = read([rule({ resourceId: "c1", actions: ["view"] })])
    expect(at(answers, "c1", "view")).toBe("allow")
    expect(at(answers, "c1", "configure")).toBeUndefined()
    expect(at(answers, "c2", "view")).toBeUndefined()
  })

  it("a targeted deny sets that answer to deny", () => {
    const { answers } = read([rule({ resourceId: "c1", effect: "deny", actions: ["view"] })])
    expect(at(answers, "c1", "view")).toBe("deny")
  })

  it("DENY WINS: an allow never overwrites a deny on the same answer", () => {
    const { answers } = read([
      rule({ resourceId: "c1", effect: "deny", actions: ["view"] }),
      rule({ resourceId: "c1", effect: "allow", actions: ["view"] }),
    ])
    expect(at(answers, "c1", "view")).toBe("deny")
  })

  it("THERE IS NO WILDCARD: `*` is just an unknown action name", () => {
    // It used to fill every column, which is what made a full-access role
    // unrepresentable here and forced the read-only banner. `*` is gone from the
    // model, so it lands in passthrough like any other action the pane does not
    // render — preserved on save, but answering nothing.
    const { answers, passthrough } = read([rule({ resourceId: "c1", actions: ["*"] })])
    expect(at(answers, "c1", "view")).toBeUndefined()
    expect(at(answers, "c1", "configure")).toBeUndefined()
    expect([...passthrough.values()].flat()).toContain("*")
  })

  /** THE CHANGE FROM THE GRID. An untargeted rule used to have nowhere to land —
   *  it folded onto a "Default value" template row that meant something else. */
  it("an untargeted rule lands on the ALL row", () => {
    const { answers } = read([rule({ actions: ["view"] })])
    expect(at(answers, ALL_ROW, "view")).toBe("allow")
    expect(at(answers, "c1", "view")).toBeUndefined()
  })

  it("a conditional rule is ignored entirely — no cell can represent one", () => {
    const { answers } = read([
      rule({ resourceId: "c1", condition: { kind: "actorIs", who: "creator" } }),
    ])
    expect(answers.size).toBe(0)
  })

  it("scopeBy concept reads conceptId, and ignores the resource-scoped column", () => {
    const groups: ReadonlyArray<Group> = [{ resourceType: "record", scopeBy: "concept" }]
    const answerable: ReadonlyArray<Answerable> = [{ resourceType: "record", action: "view" }]
    const { answers } = readAnswers(
      [
        rule({ resourceType: "record", conceptId: "c1", actions: ["view"] }),
        // A rule naming ONE record: a different grant over a different id space.
        rule({ resourceType: "record", resourceId: "rec-9", actions: ["view"] }),
      ],
      groups,
      answerable,
    )
    expect(answers.get(key("c1", "record", "view"))).toBe("allow")
    expect(answers.get(key("rec-9", "record", "view"))).toBeUndefined()
  })

  it("rules of a type the pane does not manage are ignored", () => {
    const { answers } = read([rule({ resourceType: "dashboard", resourceId: "d1" })])
    expect(answers.size).toBe(0)
  })

  it("actions the pane does not render are set aside, not dropped", () => {
    const { answers, passthrough } = read([
      rule({ resourceId: "c1", actions: ["view", "archive"] }),
    ])
    expect(at(answers, "c1", "view")).toBe("allow")
    // `archive` is not a column here, so it has no answer …
    expect(at(answers, "c1", "archive")).toBeUndefined()
    // … but it is remembered.
    expect(passthrough.get("c1:concept:allow")).toEqual(["archive"])
  })
})

describe("writeGroups", () => {
  const write = (answers: Map<string, CellState>, passthrough = new Map()) =>
    writeGroups(answers, passthrough, CONCEPT, ANSWERABLE, ROWS)

  it("an all-inherit pane writes no entries at all", () => {
    expect(write(new Map())[0]!.entries).toEqual([])
  })

  it("splits a row's answers into its allow and deny lists", () => {
    const answers = new Map<string, CellState>([
      [key("c1", "concept", "view"), "allow"],
      [key("c1", "concept", "configure"), "deny"],
    ])
    const [group] = write(answers)
    expect(group!.entries).toEqual([{ resourceId: "c1", allow: ["view"], deny: ["configure"] }])
  })

  it("the ALL row writes a null resourceId — the blanket rule", () => {
    const answers = new Map<string, CellState>([[key(ALL_ROW, "concept", "view"), "allow"]])
    const [group] = write(answers)
    expect(group!.entries).toEqual([{ resourceId: null, allow: ["view"], deny: [] }])
  })

  /**
   * THE ROUND TRIP THAT MATTERS. `setRoleRules` replaces everything of a shape, so an
   * action the pane cannot draw is destroyed unless it is carried back out. The
   * wildcard is the case with teeth: expanding `*` into today's actions would freeze
   * a full-access role, silently narrowing it every time a new action ships.
   */
  it("carries the wildcard and unrendered actions back out untouched", () => {
    const { answers, passthrough } = read([rule({ resourceId: "c1", actions: ["*"] })])
    const [group] = writeGroups(answers, passthrough, CONCEPT, ANSWERABLE, ROWS)
    expect(group!.entries[0]!.allow).toContain("*")
  })

  it("a row left with only passthrough still writes its entry", () => {
    const passthrough = new Map([["c1:concept:allow", ["share"]]])
    const [group] = write(new Map(), passthrough)
    expect(group!.entries).toEqual([{ resourceId: "c1", allow: ["share"], deny: [] }])
  })

  it("read then write is a no-op for rules the pane fully represents", () => {
    const rules = [
      rule({ actions: ["view"] }),
      rule({ resourceId: "c1", effect: "deny", actions: ["configure"] }),
    ]
    const { answers, passthrough } = read(rules)
    const [group] = writeGroups(answers, passthrough, CONCEPT, ANSWERABLE, ROWS)
    expect(group!.entries).toEqual([
      { resourceId: null, allow: ["view"], deny: [] },
      { resourceId: "c1", allow: [], deny: ["configure"] },
    ])
  })
})

describe("sameAnswers", () => {
  it("an absent key and an explicit inherit are the same answer", () => {
    const a = new Map<string, CellState>()
    const b = new Map<string, CellState>([[key("c1", "concept", "view"), "inherit"]])
    expect(sameAnswers(a, b)).toBe(true)
  })

  it("a real difference is a difference", () => {
    const a = new Map<string, CellState>()
    const b = new Map<string, CellState>([[key("c1", "concept", "view"), "allow"]])
    expect(sameAnswers(a, b)).toBe(false)
  })
})
