import { describe, expect, it } from "vitest"
import type { Dashboard } from "./api"
import { globalsSection, resolveView } from "./sidebarViews"

const dash = (id: string, name: string, hidden = false): Dashboard =>
  ({ id, ownerId: null, name, icon: null, position: 0, hidden, body: { widgets: [] } }) as Dashboard

const dashboards = [dash("d1", "Pipeline"), dash("d2", "Vendors"), dash("d3", "Secret", true)]

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
      { dashboards, pathname: "/dashboards/d1" },
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
      { dashboards, pathname: "/tasks" },
    )
    expect(sections[0]!.entries.map((e) => e.key)).toEqual(["g:tasks", "d:d1"])
    expect(sections[0]!.entries[0]!.active).toBe(true)
  })

  it("marks overview active only on the exact root path", () => {
    const at = (p: string) =>
      resolveView({ sections: [globalsSection("g")] }, { dashboards: [], pathname: p })[0]!
        .entries.filter((e) => e.active)
        .map((e) => e.key)
    expect(at("/")).toEqual(["g:overview"])
    expect(at("/tasks")).toEqual(["g:tasks"])
    expect(at("/settings/sidebar")).toEqual(["g:settings"])
  })

  it("keeps empty sections (they render as drop targets) and carries collapsed", () => {
    const sections = resolveView(
      { sections: [{ id: "s1", title: null, icon: null, collapsed: true, entryIds: [] }] },
      { dashboards, pathname: "/" },
    )
    expect(sections).toEqual([{ id: "s1", title: null, icon: null, collapsed: true, entries: [] }])
  })
})

describe("globalsSection", () => {
  it("seeds every global, untitled, in nav order", () => {
    const s = globalsSection()
    expect(s.title).toBeNull()
    expect(s.entryIds).toEqual([
      "global:overview",
      "global:tasks",
      "global:google-mail",
      "global:google-calendar",
      "global:members",
      "global:automations",
      "global:settings",
    ])
  })
})
