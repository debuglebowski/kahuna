import { describe, expect, it } from "vitest"
import { uploadUrlFor } from "./api"

describe("upload route", () => {
  it("targets the record route, with ?field= for a file property", () => {
    expect(uploadUrlFor({ recordId: "r1" })).toBe("/api/records/r1/attachments")
    expect(uploadUrlFor({ recordId: "r1", fieldId: "f1" })).toBe(
      "/api/records/r1/attachments?field=f1",
    )
  })

  it("targets a widget bucket with its sharing flag", () => {
    expect(uploadUrlFor({ bucketId: "b1" })).toBe("/api/buckets/b1/attachments?shared=true")
    expect(uploadUrlFor({ bucketId: "b1", shared: false })).toBe(
      "/api/buckets/b1/attachments?shared=false",
    )
  })
})
