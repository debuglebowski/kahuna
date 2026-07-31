import { describe, expect, it } from "vitest"
import { uploadTarget } from "./files"

/**
 * `uploadTarget` decides whether a Files widget shows a drop zone at all, and
 * where a dropped file lands. It gets its own tests because getting it wrong is
 * invisible: the widget renders, lists files, and silently ignores every drag —
 * which is exactly what shipped twice (a wide-scope widget on a record page, and
 * `allowUpload` being opt-in on a widget that plainly owns one record).
 */
describe("uploadTarget", () => {
  const REC = "item-lineage-1"

  it("a widget's own bucket is the target, sharing default on", () => {
    expect(uploadTarget({ scope: "widget", bucketId: "b1" })).toEqual({
      kind: "bucket",
      bucketId: "b1",
      shared: true,
    })
  })

  it("a private bucket keeps shared: false", () => {
    expect(uploadTarget({ scope: "widget", bucketId: "b1", bucketShared: false })).toMatchObject({
      shared: false,
    })
  })

  it("widget scope with no bucket has nowhere to put a file", () => {
    expect(uploadTarget({ scope: "widget", bucketId: null })).toBeNull()
  })

  it("a pinned record needs the id → lineage hop", () => {
    expect(uploadTarget({ scope: "instance", instanceId: "i1" })).toEqual({
      kind: "instance",
      instanceId: "i1",
    })
  })

  // The reported bug. A whole-org widget owns nothing, so it used to be
  // browse-only everywhere — including on a record page, where the open record is
  // an obvious destination and the user reasonably expects to drop a file.
  it("a wide scope borrows the open record on a record page", () => {
    expect(uploadTarget({ scope: "org" }, REC)).toEqual({ kind: "record", itemId: REC })
    expect(uploadTarget({ scope: "concept", conceptId: "c1" } as never, REC)).toEqual({
      kind: "record",
      itemId: REC,
    })
  })

  it("a wide scope off a record page stays browse-only", () => {
    expect(uploadTarget({ scope: "org" })).toBeNull()
    expect(uploadTarget({ scope: "concept" })).toBeNull()
  })

  // Absent means yes: it was opt-in, which rendered upload surfaces that refused
  // uploads until someone found the toggle.
  it("allowUpload absent means uploadable", () => {
    expect(uploadTarget({ scope: "widget", bucketId: "b1" })).not.toBeNull()
    expect(uploadTarget({ scope: "instance", instanceId: "i1" })).not.toBeNull()
  })

  it("allowUpload false is honoured at every scope", () => {
    expect(uploadTarget({ scope: "widget", bucketId: "b1", allowUpload: false })).toBeNull()
    expect(uploadTarget({ scope: "instance", instanceId: "i1", allowUpload: false })).toBeNull()
    expect(uploadTarget({ scope: "org", allowUpload: false }, REC)).toBeNull()
  })
})
