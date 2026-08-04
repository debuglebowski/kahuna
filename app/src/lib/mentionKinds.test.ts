import { describe, expect, it } from "vitest"
import {
  clientHrefFor,
  clientLabelFor,
  iconForKind,
  isMentionKind,
  MENTION_FALLBACK_ICON,
  MENTION_KIND_DEFS,
  MENTION_KINDS,
} from "./mentionKinds"

describe("isMentionKind", () => {
  it("accepts the six kinds and nothing else", () => {
    for (const k of MENTION_KINDS) expect(isMentionKind(k)).toBe(true)
    expect(isMentionKind("task")).toBe(false) // not mentionable: no route yet
    expect(isMentionKind("note")).toBe(false)
    expect(isMentionKind("")).toBe(false)
    expect(isMentionKind(null)).toBe(false)
    expect(isMentionKind(undefined)).toBe(false)
    expect(isMentionKind(1)).toBe(false)
  })
})

describe("MENTION_KIND_DEFS", () => {
  it("has exactly one entry per kind, keyed by itself", () => {
    expect(Object.keys(MENTION_KIND_DEFS).sort()).toEqual([...MENTION_KINDS].sort())
    for (const k of MENTION_KINDS) expect(MENTION_KIND_DEFS[k].kind).toBe(k)
  })
})

describe("iconForKind", () => {
  it("degrades an unknown kind to the fallback rather than throwing", () => {
    // A mention written by a newer build must still render — only its icon is lost.
    expect(iconForKind("record")).toBe(MENTION_KIND_DEFS.record.Icon)
    expect(iconForKind("something-new")).toBe(MENTION_FALLBACK_ICON)
    expect(iconForKind(undefined)).toBe(MENTION_FALLBACK_ICON)
  })
})

describe("clientHrefFor", () => {
  it("resolves a page mention from the static nav table", () => {
    expect(clientHrefFor({ kind: "page", targetId: "overview" })).toBe("/")
    expect(clientHrefFor({ kind: "page", targetId: "tasks" })).toBe("/tasks")
    expect(clientHrefFor({ kind: "page", targetId: "settings" })).toBe("/settings")
  })

  it("returns null for an unknown page key", () => {
    expect(clientHrefFor({ kind: "page", targetId: "nope" })).toBe(null)
  })

  it("THE ENFORCEMENT-AT-THE-LINK GUARD: never synthesizes an href for other kinds", () => {
    // A null href from the server means "unresolvable FOR THIS CALLER" — that is
    // where mention permissions are enforced. Guessing a route client-side would
    // hand out a working link to something the caller may not read.
    for (const kind of ["record", "person", "concept", "dashboard", "file"]) {
      expect(clientHrefFor({ kind, targetId: "any-id" })).toBe(null)
      expect(clientHrefFor({ kind, targetId: "any-id", href: null })).toBe(null)
    }
  })

  it("passes a server-resolved href through untouched", () => {
    expect(clientHrefFor({ kind: "record", targetId: "i", href: "/instances/abc" })).toBe(
      "/instances/abc",
    )
    // …including one shaped unlike an SPA route (a file download endpoint).
    expect(
      clientHrefFor({ kind: "file", targetId: "f", href: "/api/attachments/f/download" }),
    ).toBe("/api/attachments/f/download")
  })
})

describe("clientLabelFor", () => {
  it("names a page from the nav table, and prefers a resolved label", () => {
    expect(clientLabelFor({ kind: "page", targetId: "members" })).toBe("Members")
    expect(clientLabelFor({ kind: "page", targetId: "members", label: "Live" })).toBe("Live")
    expect(clientLabelFor({ kind: "page", targetId: "nope" })).toBe(null)
  })

  it("returns null for other kinds, leaving the document's cached label to stand", () => {
    expect(clientLabelFor({ kind: "record", targetId: "abc" })).toBe(null)
    expect(clientLabelFor({ kind: "record", targetId: "abc", label: "Acme" })).toBe("Acme")
  })
})
