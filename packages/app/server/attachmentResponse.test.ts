import { describe, expect, it } from "vitest"
import { attachmentResponse } from "./attachmentResponse"
import { appSecurityHeaders, attachmentSecurityHeaders, withApiSecurityHeaders } from "./headers"

const bytes = new TextEncoder().encode("Uploaded content")
const response = (mimeType: string | null, inline = true, filename = "test.txt") =>
  withApiSecurityHeaders(attachmentResponse({ filename, mimeType }, bytes, inline))

describe("attachment preview responses", () => {
  it("lets the app frame text while preserving its opaque, script-free sandbox", async () => {
    const res = response("text/plain; charset=utf-8")
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'self'",
    )
    expect(await res.text()).toBe("Uploaded content")
  })

  it("permits the native PDF viewer without disabling framing restrictions or nosniff", () => {
    const res = response("application/pdf", true, "document.pdf")
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    )
    expect(appSecurityHeaders()["content-security-policy"]).toContain("object-src 'self'")
  })

  it.each(["text/html", "TEXT/HTML; charset=utf-8", "image/svg+xml", "application/xml", null])(
    "forces %s to a download even with an inline request and a misleading filename",
    (mime) => {
      const res = response(mime, true, "looks-safe.pdf")
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/)
      expect(res.headers.get("content-type")).toBe("application/octet-stream")
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox; frame-ancestors 'none'",
      )
    },
  )

  it("keeps download and error responses unframeable", () => {
    expect(response("text/plain", false).headers.get("x-frame-options")).toBe("DENY")
    expect(attachmentSecurityHeaders()["x-frame-options"]).toBe("DENY")
  })

  it("keeps the app unframeable and rejects external embed sources", () => {
    const headers = appSecurityHeaders()
    expect(headers["x-frame-options"]).toBe("DENY")
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(headers["content-security-policy"]).not.toContain("object-src *")
  })

  it("does not let a filename inject response headers", () => {
    const res = response("text/plain", true, 'note"\r\nX-Injected: yes.txt')
    expect(res.headers.has("x-injected")).toBe(false)
    expect(res.headers.get("content-disposition")).not.toMatch(/[\r\n]/)
  })
})
