import { describe, expect, it } from "vitest"
import type { Concept, Dashboard } from "./api"
import { conceptEntryId, globalsSection, resolveView } from "./sidebarViews"

const dash = (id: string, name: string, hidden = false): Dashboard =>
  ({ id, ownerId: null, name, icon: null, position: 0, hidden, body: { widgets: [] } }) as Dashboard

const dashboards = [dash("d1", "Pipeline"), dash("d2", "Vendors"), dash("d3", "Secret", true)]

const concept = (patch: Partial<Concept> = {}): Concept =>
  ({
    id: "c1",
    slug: "company",
    name: "Company",
    icon: null,
    singleRecord: true,
    archivedAt: null,
    ...patch,
  }) as Concept

const concepts = [concept()]

describe("resolveView", () => {
  it("resolves placed entries in order, skipping deleted, hidden, and duplicate ids", () => {
    const sections = resolveView(
      {
        sections: [
          {
            id: "s1",
            title: "Work",
            icon: null,
            entryIds: ["d2", "gone", "d3", "d1", "d2"],
          },
        ],
      },
      { dashboards, concepts, pathname: "/dashboards/d1" },
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.entries.map((e) => e.key)).toEqual(["d:d2", "d:d1"])
    expect(sections[0]!.entries.map((e) => e.active)).toEqual([false, true])
    expect(sections[0]!.entries[0]!.to).toBe("/dashboards/d2")
  })

  it("resolves globals like any entry, mixed with dashboards; unknown keys skipped", () => {
    const sections = resolveView(
      {
        sections: [
          {
            id: "s1",
            title: null,
            icon: null,
            entryIds: ["global:tasks", "d1", "global:nope"],
          },
        ],
      },
      { dashboards, concepts, pathname: "/tasks" },
    )
    expect(sections[0]!.entries.map((e) => e.key)).toEqual(["g:tasks", "d:d1"])
    expect(sections[0]!.entries[0]!.active).toBe(true)
  })

  it("marks overview active only on the exact root path", () => {
    const at = (p: string) =>
      resolveView(
        { sections: [globalsSection("g")] },
        { dashboards: [], concepts: [], pathname: p },
      )[0]!
        .entries.filter((e) => e.active)
        .map((e) => e.key)
    expect(at("/")).toEqual(["g:overview"])
    expect(at("/tasks")).toEqual(["g:tasks"])
    expect(at("/settings/sidebar")).toEqual(["g:settings"])
  })

  it("keeps empty sections (they render as drop targets) and carries collapsed", () => {
    const sections = resolveView(
      { sections: [{ id: "s1", title: null, icon: null, collapsed: true, entryIds: [] }] },
      { dashboards, concepts, pathname: "/" },
    )
    expect(sections).toEqual([{ id: "s1", title: null, icon: null, collapsed: true, entries: [] }])
  })

  // Concept entries are keyed by id but addressed by slug: the entry survives a
  // rename (and a re-slug never happens, slugs being immutable by convention).
  it("resolves a single-record concept entry to its slug URL", () => {
    const at = (pathname: string) =>
      resolveView(
        { sections: [{ id: "s1", title: null, icon: null, entryIds: [conceptEntryId("c1")] }] },
        { dashboards, concepts: [concept({ name: "Renamed Co" })], pathname },
      )[0]!.entries
    const [entry] = at("/c/company")
    expect(entry).toMatchObject({
      key: "c:c1",
      label: "Renamed Co",
      to: "/c/company",
      active: true,
    })
    expect(at("/c/other")[0]!.active).toBe(false)
  })

  it("skips a concept entry whose concept is gone, archived, or no longer single-record", () => {
    const only = (cs: readonly Concept[]) =>
      resolveView(
        { sections: [{ id: "s1", title: null, icon: null, entryIds: [conceptEntryId("c1")] }] },
        { dashboards, concepts: cs, pathname: "/" },
      )[0]!.entries
    expect(only([])).toEqual([])
    expect(only([concept({ archivedAt: new Date() })])).toEqual([])
    expect(only([concept({ singleRecord: false })])).toEqual([])
  })

  // The `concept:` prefix must be claimed before the dashboard fallback, or a
  // prefixed id would be looked up as a dashboard uuid and render as missing.
  it("does not mistake a concept entry id for a dashboard id", () => {
    const entries = resolveView(
      {
        sections: [{ id: "s1", title: null, icon: null, entryIds: [conceptEntryId("d1"), "d1"] }],
      },
      { dashboards, concepts, pathname: "/" },
    )[0]!.entries
    // `concept:d1` resolves to no concept (skipped); the bare `d1` is the dashboard.
    expect(entries.map((e) => e.key)).toEqual(["d:d1"])
  })
})

describe("globalsSection", () => {
  it("seeds every global, untitled, in nav order", () => {
    const s = globalsSection()
    expect(s.title).toBeNull()
    expect(s.entryIds).toEqual([
      "global:overview",
      "global:tasks",
      "global:members",
      "global:automations",
      "global:settings",
    ])
  })
})
