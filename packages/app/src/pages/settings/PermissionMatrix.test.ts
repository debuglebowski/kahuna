import { describe, expect, it } from "vitest"
import {
  blanketDenyCells,
  DEFAULT_ROW,
  key,
  type MatrixDefault,
  type MatrixItem,
  type MatrixRule,
  stateFrom,
} from "./PermissionMatrix"

/**
 * The tri-state fold (P7): `stateFrom` turns a role's raw rules into the cell
 * states the grid renders and edits, and `blanketDenyCells` carves out the one
 * case that still can't be a per-cell state (an untargeted deny, which blocks
 * every row at once). Both are pure — no server, no rendering — so the folding
 * logic is tested directly rather than through the component.
 */

const rule = (over: Partial<MatrixRule> = {}): MatrixRule => ({
  id: over.id ?? "r1",
  effect: over.effect ?? "allow",
  actions: over.actions ?? ["view"],
  resourceType: over.resourceType ?? "concept",
  resourceId: over.resourceId ?? null,
  conceptId: over.conceptId ?? null,
  condition: over.condition ?? null,
})

const ITEMS: ReadonlyArray<MatrixItem> = [
  { id: "c1", name: "Deals" },
  { id: "c2", name: "People" },
]
const ACTIONS = ["view", "configure"] as const

describe("stateFrom", () => {
  it("no rules at all: every cell is absent (the caller defaults it to inherit)", () => {
    const out = stateFrom([], [], "concept", [...ACTIONS], "resource")
    expect(out.size).toBe(0)
  })

  it("a targeted allow sets that cell, and only that cell", () => {
    const out = stateFrom(
      [rule({ resourceId: "c1", actions: ["view"] })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.get(key("c1", "view"))).toBe("allow")
    expect(out.get(key("c1", "configure"))).toBeUndefined()
    expect(out.get(key("c2", "view"))).toBeUndefined()
  })

  it("a targeted deny sets that cell to deny", () => {
    const out = stateFrom(
      [rule({ resourceId: "c1", effect: "deny", actions: ["view"] })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.get(key("c1", "view"))).toBe("deny")
  })

  it("DENY WINS: a targeted allow never overwrites a targeted deny on the same cell", () => {
    const out = stateFrom(
      [
        rule({ id: "deny", resourceId: "c1", effect: "deny", actions: ["view"] }),
        rule({ id: "allow", resourceId: "c1", effect: "allow", actions: ["view"] }),
      ],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.get(key("c1", "view"))).toBe("deny")
  })

  it("the wildcard action covers every column", () => {
    const out = stateFrom(
      [rule({ resourceId: "c1", actions: ["*"] })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.get(key("c1", "view"))).toBe("allow")
    expect(out.get(key("c1", "configure"))).toBe("allow")
  })

  it("a rule for a different resourceType is ignored", () => {
    const out = stateFrom(
      [rule({ resourceType: "dashboard", resourceId: "c1", actions: ["view"] })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.size).toBe(0)
  })

  it("a conditional rule is ignored — a cell has nowhere to put a condition", () => {
    const out = stateFrom(
      [rule({ resourceId: "c1", condition: { kind: "actorIs", who: "creator" } })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.size).toBe(0)
  })

  it("scopeBy=concept reads a record rule's conceptId, not its resourceId", () => {
    const out = stateFrom(
      [rule({ resourceType: "record", conceptId: "c1", actions: ["view"] })],
      [],
      "record",
      [...ACTIONS],
      "concept",
    )
    expect(out.get(key("c1", "view"))).toBe("allow")
  })

  it("a record rule NAMING one record (resourceId set) is invisible to the concept-scoped grid", () => {
    // That is a per-record share, a different grant over the same uuid space —
    // this grid must not read it, or it would read one thing and overwrite another.
    const out = stateFrom(
      [rule({ resourceType: "record", resourceId: "rec-1", actions: ["view"] })],
      [],
      "record",
      [...ACTIONS],
      "concept",
    )
    expect(out.size).toBe(0)
  })

  it("the creation template (access_defaults) seeds the DEFAULT_ROW, allow effect", () => {
    const defaults: ReadonlyArray<MatrixDefault> = [
      { roleId: "role-1", resourceType: "concept", effect: "allow", actions: ["view"] },
    ]
    const out = stateFrom([], defaults, "concept", [...ACTIONS], "resource")
    expect(out.get(key(DEFAULT_ROW, "view"))).toBe("allow")
  })

  it("a deny template also seeds the DEFAULT_ROW", () => {
    const defaults: ReadonlyArray<MatrixDefault> = [
      { roleId: "role-1", resourceType: "concept", effect: "deny", actions: ["view"] },
    ]
    const out = stateFrom([], defaults, "concept", [...ACTIONS], "resource")
    expect(out.get(key(DEFAULT_ROW, "view"))).toBe("deny")
  })

  it("a deny template beats an allow template for the same role — deny folds first", () => {
    const defaults: ReadonlyArray<MatrixDefault> = [
      {
        roleId: "role-1",
        resourceType: "concept",
        effect: "allow",
        actions: ["view", "configure"],
      },
      { roleId: "role-1", resourceType: "concept", effect: "deny", actions: ["view"] },
    ]
    const out = stateFrom([], defaults, "concept", [...ACTIONS], "resource")
    expect(out.get(key(DEFAULT_ROW, "view"))).toBe("deny")
    expect(out.get(key(DEFAULT_ROW, "configure"))).toBe("allow")
  })

  it("an untargeted deny is NOT folded in here — that's blanketDenyCells' job", () => {
    const out = stateFrom(
      [rule({ effect: "deny", actions: ["view"] })],
      [],
      "concept",
      [...ACTIONS],
      "resource",
    )
    expect(out.size).toBe(0)
  })
})

describe("blanketDenyCells", () => {
  it("an untargeted deny blocks EVERY item row, for the actions it names", () => {
    const out = blanketDenyCells(
      [rule({ effect: "deny", actions: ["view"] })],
      "concept",
      [...ACTIONS],
      ITEMS,
    )
    expect(out.has(key("c1", "view"))).toBe(true)
    expect(out.has(key("c2", "view"))).toBe(true)
    expect(out.has(key("c1", "configure"))).toBe(false)
  })

  it("a TARGETED deny is not a blanket — it's a real per-cell state now, not here", () => {
    const out = blanketDenyCells(
      [rule({ effect: "deny", resourceId: "c1", actions: ["view"] })],
      "concept",
      [...ACTIONS],
      ITEMS,
    )
    expect(out.size).toBe(0)
  })

  it("an untargeted ALLOW is not tracked here either — only deny blocks read-only", () => {
    const out = blanketDenyCells(
      [rule({ effect: "allow", actions: ["view"] })],
      "concept",
      [...ACTIONS],
      ITEMS,
    )
    expect(out.size).toBe(0)
  })

  it("a conditional rule is never a blanket, whatever its effect", () => {
    const out = blanketDenyCells(
      [rule({ effect: "deny", condition: { kind: "actorIs", who: "creator" } })],
      "concept",
      [...ACTIONS],
      ITEMS,
    )
    expect(out.size).toBe(0)
  })
})
