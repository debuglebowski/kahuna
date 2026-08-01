import { describe, expect, it } from "vitest"
import { isNewer, newestStable, nextPageUrl, versionInfo } from "./version"

describe("nextPageUrl — GHCR pagination", () => {
  it("resolves the path-only next link against ghcr.io", () => {
    // The real header shape, copied from a live response. Following this is not
    // optional: GHCR caps pages at 100 tags and orders them by INSERTION, so the
    // newest release sits on the last page.
    const link = '</v2/astral-sh/uv/tags/list?last=0.4-python3.9-bookworm&n=0>; rel="next"'
    expect(nextPageUrl(link)).toBe(
      "https://ghcr.io/v2/astral-sh/uv/tags/list?last=0.4-python3.9-bookworm&n=0",
    )
  })

  it("returns null on the last page (no header)", () => {
    expect(nextPageUrl(null)).toBe(null)
    expect(nextPageUrl("")).toBe(null)
  })

  it("ignores non-next relations", () => {
    expect(nextPageUrl('</v2/x/tags/list?n=1>; rel="prev"')).toBe(null)
    expect(
      nextPageUrl('</v2/x/tags/list?a=1>; rel="prev", </v2/x/tags/list?b=2>; rel="next"'),
    ).toBe("https://ghcr.io/v2/x/tags/list?b=2")
  })
})

describe("isNewer — component-wise, not lexicographic", () => {
  it("compares numerically past the ninth release", () => {
    // The bug this exists for: as strings, "0.10.0" < "0.9.0", so a lexicographic
    // compare stops offering updates after the tenth minor release.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
    expect(isNewer("0.2.10", "0.2.9")).toBe(true)
  })

  it("is false for equal versions", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false)
  })

  it("tolerates a leading v on either side", () => {
    expect(isNewer("v1.2.4", "1.2.3")).toBe(true)
    expect(isNewer("1.2.4", "v1.2.3")).toBe(true)
  })

  it("is false when either side is unparseable", () => {
    // `dev` is the version a source checkout / un-stamped image reports. It must
    // never be treated as older than a real release, or every dev run nags.
    expect(isNewer("1.0.0", "dev")).toBe(false)
    expect(isNewer("dev", "1.0.0")).toBe(false)
    expect(isNewer("latest", "1.0.0")).toBe(false)
    expect(isNewer("1.0.0", "")).toBe(false)
  })

  it("refuses prereleases and build metadata", () => {
    // A self-hoster on 1.0.0 must not be pointed at 1.1.0-rc.1.
    expect(isNewer("1.1.0-rc.1", "1.0.0")).toBe(false)
    expect(isNewer("1.1.0+abc123", "1.0.0")).toBe(false)
  })
})

describe("newestStable — picking a release out of a registry tag list", () => {
  it("ignores the non-version tags GHCR also carries", () => {
    // A real tags/list response mixes moving tags and per-commit tags in with
    // the releases.
    const tags = ["latest", "main", "sha-deadbeef", "0.1.0", "0.2.0", "0.1"]
    expect(newestStable(tags)).toBe("0.2.0")
  })

  it("prefers the highest, not the last", () => {
    expect(newestStable(["0.3.0", "0.10.0", "0.4.0"])).toBe("0.10.0")
  })

  it("skips prereleases", () => {
    expect(newestStable(["1.0.0", "1.1.0-rc.1"])).toBe("1.0.0")
  })

  it("returns null when nothing is a release", () => {
    expect(newestStable(["latest", "main", "sha-abc"])).toBe(null)
    expect(newestStable([])).toBe(null)
  })

  it("keeps the leading v if that is how the tag is published", () => {
    // `{{version}}` from docker/metadata-action strips the v, but a hand-pushed
    // tag might not — it should still be found and reported as published.
    expect(newestStable(["v0.2.0", "v0.1.0"])).toBe("v0.2.0")
  })
})

describe("versionInfo", () => {
  it("never claims an update on an un-stamped build, and reports no false positive before the first check", () => {
    // No check has run in this test process, so `latest` is null.
    const info = versionInfo()
    expect(info.latest).toBe(null)
    expect(info.updateAvailable).toBe(false)
    expect(info.checkedAt).toBe(null)
    // Unstamped in the test env.
    expect(info.current).toBe("dev")
  })
})
