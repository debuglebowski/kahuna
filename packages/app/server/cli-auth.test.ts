import { describe, expect, it } from "vitest"
import {
  approveDevice,
  devicePage,
  __normaliseForTest as normalise,
  __pendingForTest as pending,
  pollDevice,
  startDevice,
  __userCodeForTest as userCode,
} from "./cli-auth"

const req = (url: string, init?: RequestInit) => new Request(`http://localhost:3100${url}`, init)

describe("the user code", () => {
  it("is XXXX-XXXX and avoids glyphs that get misread", () => {
    for (let i = 0; i < 200; i++) {
      const code = userCode()
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      // 0/O and 1/I/L are read off one screen and typed on another.
      expect(code).not.toMatch(/[O01IL]/)
    }
  })

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 500 }, () => userCode()))
    expect(seen.size).toBe(500)
  })
})

describe("what a person may type", () => {
  it("accepts the code in the shapes people actually enter it", () => {
    // Lower case, no dash, spaces, and stray punctuation all normalise to one.
    for (const typed of ["wdjb-mjht", "WDJBMJHT", "wdjb mjht", "WDJB–MJHT", " wdjb-mjht "]) {
      expect(normalise(typed)).toBe("WDJB-MJHT")
    }
  })
})

describe("starting a flow", () => {
  it("hands back a device code, a user code and where to go", async () => {
    const res = await startDevice(req("/api/cli/device", { method: "POST" }))
    const body = (await res.json()) as Record<string, string | number>
    expect(String(body.userCode)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(String(body.deviceCode).length).toBeGreaterThan(30)
    // ONE url, carrying the code; opening it asks for confirmation.
    expect(String(body.verificationUri)).toBe(
      `http://localhost:3100/api/cli/device?code=${body.userCode}`,
    )
    expect(Number(body.expiresInSeconds)).toBeGreaterThan(0)
  })

  it("needs no session — nobody is signed in yet, which is the point", async () => {
    expect((await startDevice(req("/api/cli/device", { method: "POST" }))).status).toBe(200)
  })
})

describe("the approval page", () => {
  it("sends an unauthenticated browser to sign in, keeping the code", async () => {
    const res = await devicePage(req("/api/cli/device?code=WDJB-MJHT"))
    expect(res.status).toBe(302)
    const location = decodeURIComponent(res.headers.get("location") ?? "")
    expect(location).toContain("/?next=")
    // Signing in has to land back on the approval page WITH the code, or the
    // person has to retype it and the flow feels broken.
    expect(location).toContain("/api/cli/device?code=WDJB-MJHT")
  })
})

describe("polling", () => {
  it("says pending until someone approves", async () => {
    const started = await startDevice(req("/api/cli/device", { method: "POST" }))
    const { deviceCode } = (await started.json()) as { deviceCode: string }
    const res = await pollDevice(
      req("/api/cli/device/poll", { method: "POST", body: JSON.stringify({ deviceCode }) }),
    )
    expect((await res.json()).status).toBe("pending")
  })

  it("hands the credential over exactly once", async () => {
    pending.set("dev-1", {
      userCode: "AAAA-BBBB",
      status: "approved",
      cookie: "session=abc",
      userId: "u1",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    const first = await pollDevice(
      req("/api/cli/device/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: "dev-1" }),
      }),
    )
    expect(await first.json()).toMatchObject({ status: "approved", cookie: "session=abc" })
    // A captured device code must be worthless afterwards.
    const second = await pollDevice(
      req("/api/cli/device/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: "dev-1" }),
      }),
    )
    expect((await second.json()).status).toBe("expired")
  })

  it("refuses an unknown or expired device code", async () => {
    pending.set("dev-old", {
      userCode: "CCCC-DDDD",
      status: "pending",
      expiresAt: Date.now() - 1,
      attempts: 0,
    })
    for (const code of ["never-existed", "dev-old"]) {
      const res = await pollDevice(
        req("/api/cli/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: code }) }),
      )
      expect(res.status).toBe(400)
    }
  })

  it("refuses a request with no device code", async () => {
    const res = await pollDevice(req("/api/cli/device/poll", { method: "POST", body: "{}" }))
    expect(res.status).toBe(400)
  })

  it("drops a client that polls far faster than it was told to", async () => {
    pending.set("dev-spam", {
      userCode: "EEEE-FFFF",
      status: "pending",
      expiresAt: Date.now() + 600_000,
      attempts: 10_000,
    })
    const res = await pollDevice(
      req("/api/cli/device/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: "dev-spam" }),
      }),
    )
    expect(res.status).toBe(400)
    expect(pending.has("dev-spam")).toBe(false)
  })
})

describe("approving", () => {
  it("refuses a cross-origin or origin-less POST, leaving the request pending", async () => {
    pending.set("dev-x", {
      userCode: "QQQQ-RRRR",
      status: "pending",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    const body = new URLSearchParams({ code: "QQQQ-RRRR" })
    for (const headers of [{}, { origin: "https://evil.example" }] as Record<string, string>[]) {
      const res = await approveDevice(
        req("/api/cli/device/approve", {
          method: "POST",
          body,
          headers: { cookie: "s=1", ...headers },
        }),
      )
      expect(res.status).toBe(403)
    }
    expect(pending.get("dev-x")?.status).toBe("pending")
  })
})

describe("the link itself", () => {
  it("refuses without a session, and leaves the request untouched", async () => {
    pending.set("dev-2", {
      userCode: "GGGG-HHHH",
      status: "pending",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    // Redirected to sign in — NOT approved. An unauthenticated GET must not
    // consume or approve a live request, which matters more now that a mere
    // page load is what authorises.
    const res = await devicePage(req("/api/cli/device?code=GGGG-HHHH"))
    expect(res.status).toBe(302)
    expect(pending.get("dev-2")?.status).toBe("pending")
  })

  it("tells an unauthenticated visitor NOTHING about which codes are live", async () => {
    // The session is checked before the code is looked at, so every visit gets
    // the same sign-in bounce whether the code is real, spent or invented.
    // (What a SIGNED-IN visitor sees for a stale code is asserted end to end by
    // verify-cli.ts, which can hold a real session.)
    pending.set("dev-4", {
      userCode: "LLLL-MMMM",
      status: "pending",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    const real = await devicePage(req("/api/cli/device?code=LLLL-MMMM"))
    const fake = await devicePage(req("/api/cli/device?code=ZZZZ-ZZZZ"))
    const none = await devicePage(req("/api/cli/device"))
    expect(real.status).toBe(302)
    expect(fake.status).toBe(302)
    expect(none.status).toBe(302)
    expect(pending.get("dev-4")?.status).toBe("pending")
  })
})
